//! Device-control tools User can use when powered by OpenRouter.
//! (When powered by Claude Code, Claude Code's own tools are used instead.)

use crate::settings::Settings;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub fn tool_defs() -> Value {
    let shell = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
    json!([
        { "type": "function", "function": {
            "name": "open_app",
            "description": "Open / launch an application installed on the user's computer, by its name (e.g. \"Spotify\", \"Notepad\", \"Calculator\", \"firefox\").",
            "parameters": { "type": "object", "properties": { "name": { "type": "string", "description": "Application name" } }, "required": ["name"] } } },
        { "type": "function", "function": {
            "name": "open_url",
            "description": "Open a web page in the user's default browser. Also use for searches, e.g. https://www.google.com/search?q=...",
            "parameters": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] } } },
        { "type": "function", "function": {
            "name": "open_path",
            "description": "Open a file or folder on the user's computer with its default program. \"~\" means the home folder.",
            "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } } },
        { "type": "function", "function": {
            "name": "run_command",
            "description": format!("Run a shell command on the user's computer and get its output. OS: {}. Shell: {shell}. Use it for controlling the device (volume, files, system info, closing apps, etc).", std::env::consts::OS),
            "parameters": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] } } }
    ])
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn short(t: &str, n: usize) -> String {
    t.chars().take(n).collect()
}

pub fn describe(name: &str, args: &Value) -> String {
    match name {
        "open_app" => format!("opening {}", s(args, "name")),
        "open_url" => format!("opening {}", short(s(args, "url").trim_start_matches("https://").trim_start_matches("http://"), 40)),
        "open_path" => format!("opening {}", s(args, "path")),
        "run_command" => format!("running {}", short(&s(args, "command"), 40)),
        other => other.to_string(),
    }
}

pub fn home() -> std::path::PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(Into::into)
        .unwrap_or_else(|| ".".into())
}

fn expand_home(p: &str) -> String {
    if p == "~" || p.starts_with("~/") || p.starts_with("~\\") {
        format!("{}{}", home().display(), &p[1..])
    } else {
        p.to_string()
    }
}

async fn launch_app(name: String) -> String {
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // `start` resolves App Paths registrations (spotify, chrome, notepad, ...)
            let safe: String = name.chars().filter(|c| !"\"&|<>^%".contains(*c)).collect();
            let status = std::process::Command::new("cmd.exe")
                .raw_arg(format!("/d /s /c \"start \"\" \"{safe}\"\""))
                .creation_flags(0x0800_0000)
                .status();
            return match status {
                Ok(s) if s.success() => format!("opened {name}"),
                Ok(s) => format!("could not open \"{name}\" ({s})"),
                Err(e) => format!("could not open \"{name}\": {e}"),
            };
        }
        #[cfg(target_os = "macos")]
        {
            return match std::process::Command::new("open").args(["-a", &name]).status() {
                Ok(s) if s.success() => format!("opened {name}"),
                _ => format!("could not find an app called \"{name}\""),
            };
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let bin = name.to_lowercase().replace(' ', "-");
            let spawned = std::process::Command::new(&bin)
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn();
            if spawned.is_ok() {
                return format!("opened {name}");
            }
            match std::process::Command::new("gtk-launch").arg(&bin).status() {
                Ok(s) if s.success() => format!("opened {name}"),
                _ => format!("could not find an app called \"{name}\""),
            }
        }
    })
    .await
    .unwrap_or_else(|e| format!("error: {e}"))
}

async fn confirm(app: &AppHandle, command: &str) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(command)
        .title("User wants to run a command on your computer")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Deny".into()))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    rx.await.unwrap_or(false)
}

async fn run_command(command: &str) -> String {
    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.args(["/d", "/c", command]);
        c
    } else {
        let mut c = tokio::process::Command::new("/bin/sh");
        c.args(["-c", command]);
        c
    };
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd.current_dir(home()).stdin(Stdio::null()).kill_on_drop(true);
    match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
        Err(_) => "error: the command timed out after 30 seconds".into(),
        Ok(Err(e)) => format!("error: {e}"),
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.trim().is_empty() {
                text.push_str("\n[stderr]\n");
                text.push_str(&err);
            }
            let text = text.trim();
            if text.is_empty() {
                format!("(no output, exit {})", out.status)
            } else {
                short(text, 4000)
            }
        }
    }
}

pub async fn run_tool(app: &AppHandle, name: &str, args: &Value, settings: &Settings) -> String {
    if !settings.device_control {
        return "Device control is disabled in settings. Tell the user they can enable it.".into();
    }
    match name {
        "open_app" => launch_app(s(args, "name")).await,
        "open_url" => {
            let mut url = s(args, "url");
            if !url.starts_with("http://") && !url.starts_with("https://") {
                url = format!("https://{url}");
            }
            match open::that_detached(&url) {
                Ok(_) => format!("opened {url}"),
                Err(e) => format!("error: {e}"),
            }
        }
        "open_path" => {
            let p = expand_home(&s(args, "path"));
            match open::that_detached(&p) {
                Ok(_) => format!("opened {p}"),
                Err(e) => format!("error: {e}"),
            }
        }
        "run_command" => {
            let command = s(args, "command");
            if settings.confirm_commands && !confirm(app, &command).await {
                return "The user denied running this command.".into();
            }
            run_command(&command).await
        }
        other => format!("unknown tool {other}"),
    }
}
