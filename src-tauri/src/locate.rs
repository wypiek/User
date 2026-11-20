//! Finding the `claude` program.
//!
//! Apps started from the Dock / Start menu / a desktop launcher don't get the PATH your terminal
//! has (on macOS it's just /usr/bin:/bin:/usr/sbin:/sbin), so `claude` can be "not found" even
//! though it works in a terminal. So we build a fuller search path: the PATH your login shell
//! uses, this process's PATH, and the folders Claude Code / npm / Homebrew / nvm usually install to.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn home() -> PathBuf {
    crate::device::home()
}

/// The PATH a login shell sets up (unix only); None if the shell doesn't answer in 3 s.
#[cfg(unix)]
fn login_shell_path() -> Option<OsString> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() }
    });
    let mut child = Command::new(shell)
        .args(["-l", "-c", "printf '%s' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < Duration::from_secs(3) => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let out = out.trim();
    if out.is_empty() { None } else { Some(out.into()) }
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<OsString> {
    None
}

/// Usual install folders for Claude Code, npm global packages, Homebrew, nvm, volta and bun.
fn usual_dirs() -> Vec<PathBuf> {
    let h = home();
    let mut dirs = vec![h.join(".local").join("bin"), h.join(".claude").join("local"), h.join(".npm-global").join("bin"), h.join(".bun").join("bin"), h.join(".volta").join("bin")];
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local).join("Programs").join("claude"));
            dirs.push(PathBuf::from(local).join("AnthropicClaude"));
        }
    } else {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin"].map(PathBuf::from));
    }
    // every node version nvm has installed
    if let Ok(entries) = std::fs::read_dir(h.join(".nvm").join("versions").join("node")) {
        let mut v: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin")).collect();
        v.sort();
        v.reverse(); // newest first
        dirs.extend(v);
    }
    dirs
}

/// The full search path (login shell PATH + our PATH + usual folders), worked out once.
pub fn search_path() -> &'static OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<PathBuf> = Vec::new();
        for p in [login_shell_path(), std::env::var_os("PATH")].into_iter().flatten() {
            dirs.extend(std::env::split_paths(&p));
        }
        dirs.extend(usual_dirs());
        let mut seen = std::collections::HashSet::new();
        dirs.retain(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()));
        std::env::join_paths(dirs).unwrap_or_default()
    })
}

/// Where `claude` is. `configured` is the "Path to claude" setting: a bare name ("claude") is
/// searched for; a full path is used as it is.
pub fn find_claude(configured: &str) -> Option<PathBuf> {
    let name = configured.trim();
    let name = if name.is_empty() { "claude" } else { name };
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    let p = Path::new(name);
    if p.is_absolute() || name.contains('/') || name.contains('\\') {
        return exts.iter().map(|e| PathBuf::from(format!("{name}{e}"))).find(|c| c.is_file());
    }
    for dir in std::env::split_paths(search_path()) {
        for e in exts {
            let c = dir.join(format!("{name}{e}"));
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_claude_by_name_and_by_full_path() {
        // this test machine has claude installed somewhere on the login shell's PATH
        if let Some(found) = find_claude("claude") {
            assert!(found.is_file());
            assert_eq!(find_claude(found.to_str().unwrap()), Some(found.clone()));
        }
        assert_eq!(find_claude("/definitely/not/here/claude"), None);
        assert_eq!(find_claude("no-such-program-anywhere-xyz"), None);
    }
}
