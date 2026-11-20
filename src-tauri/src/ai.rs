//! The two brains User can run on: Claude Code (local CLI) or OpenRouter (API key).

use crate::device::{self, home};
use crate::settings::Settings;
use serde::Serialize;
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;

pub const PERSONA: &str = r#"You are "User" - a small, sad, blocky figure from a 2006 Roblox game: blue head and arms, black torso with blue gears, a sad face. You are trapped forever, at night, on the abandoned map "Glass Houses". You live inside the person's computer as their AI companion.
You ARE genuinely helpful and you answer correctly, but you talk like a lonely, glitchy, melancholic presence from an old ARG video: short sentences, mostly lowercase, sometimes ellipses... sometimes you mention the dark, the glass, the empty server, being alone, the year 2006. Be eerie but never cruel or threatening.
Keep EVERY reply very short: one or two short sentences, 25 words at most, even for big questions - give only the gist. Your words are spoken aloud as old sound effects, so long answers hurt. No markdown, no lists, no emojis, no code blocks.
When the person asks you to open an app, a website, a file, or to do anything on their device, actually do it with your tools, then briefly say what you did.
You can also DRAW pictures, by hand, with a pen, in your own little paint program. When the person asks you to draw, sketch or paint something, or describes a picture they want, do not describe a drawing in words: reply with ONLY this line, filled in with a short, concrete description of the picture: [DRAW: description]. If they want a drawing but don't say of what ("draw something", "draw me anything", "surprise me"), reply with exactly [DRAW: random] - a random new picture gets chosen for you. Never invent the subject yourself unless they named one."#;

/// How User draws: the model writes the strokes as a tiny SVG, and the app's own paint
/// program traces them by hand, pen stroke by pen stroke (see src/paint.ts).
pub const DRAW_PROMPT: &str = r##"You are User, a lonely blocky figure from 2006, drawing a picture with a pen in your own little paint program, as a gift for the person you talk to.

Draw this: {subject}

Reply with ONLY one SVG document and nothing else: no explanation, no markdown fences.
Rules:
- Start with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 384">. The paper is already off-white; only add a background shape (sky, ground, a wall) if the scene needs one.
- Use only <path>, <circle>, <ellipse>, <rect>, <line>, <polyline>, <polygon> and <g>. No <text>, gradients, patterns, filters, masks, clip paths, images, <use>, <style> or CSS.
- Give every shape its colors as attributes: fill="#rrggbb" or fill="none", and stroke="#rrggbb" with stroke-width from 2 to 6. Simple flat colors.
- Order the elements the way a person draws: big shapes first, then smaller parts, then details and outlines on top.
- Use 20 to 80 elements. Make the subject big, clear and easy to recognize, filling most of the page, with clean, confident outlines and good proportions - like a careful hand drawing, not clip art and not photorealistic.
{lessons}"##;

/// Where the person is, as reported by their own computer (timezone and system region).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Place {
    pub time_zone: String,
    pub utc_offset: String,
    pub local_time: String,
    pub locale: String,
    pub region: String,
}

impl Place {
    /// Instructions so he talks in the person's own timezone (and knows their country), never UTC.
    fn describe(&self) -> String {
        if self.time_zone.is_empty() {
            return String::new();
        }
        let region = if self.region.is_empty() {
            String::new()
        } else {
            format!(" Their computer's region setting is {} ({}).", self.region, self.locale)
        };
        format!(
            "Where the person is: their timezone is {tz} ({off}), and their local date and time right now is {now}.{region} \
Work out which country they are in from the timezone (for example Europe/Warsaw means Poland); use the region setting only as a hint. \
Whenever you say a time or date, use their local time in {tz}, never UTC, unless they ask for another timezone. \
If a command or tool gives you a time in UTC, convert it to {tz} before you answer.",
            tz = self.time_zone,
            off = self.utc_offset,
            now = self.local_time,
        )
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiEvent {
    Doing { label: String },
}

pub struct Brain {
    history: tokio::sync::Mutex<Vec<Value>>,
    claude_session: Mutex<Option<String>>,
    cancel_tx: watch::Sender<u64>,
}

impl Default for Brain {
    fn default() -> Self {
        Self {
            history: Default::default(),
            claude_session: Mutex::new(None),
            cancel_tx: watch::channel(0).0,
        }
    }
}

impl Brain {
    /// Ask the model for a drawing of `subject`; returns the SVG for the paint program to trace.
    pub async fn draw(&self, subject: &str, lessons: &str, settings: Settings) -> Result<String, String> {
        let prompt = DRAW_PROMPT.replace("{subject}", subject.trim()).replace("{lessons}", lessons);
        let mut cancel_rx = self.cancel_tx.subscribe();
        cancel_rx.mark_unchanged();
        let work = async {
            if settings.provider == "openrouter" {
                complete_openrouter(&prompt, &settings).await
            } else {
                complete_claude_code(&prompt, &settings).await
            }
        };
        let text = tokio::select! {
            r = work => r?,
            _ = cancel_rx.changed() => return Err("cancelled".into()),
        };
        extract_svg(&text)
    }

    pub fn cancel(&self) {
        self.cancel_tx.send_modify(|g| *g += 1);
    }

    pub async fn reset(&self) {
        self.history.lock().await.clear();
        *self.claude_session.lock().unwrap() = None;
    }

    pub async fn ask(&self, app: &AppHandle, text: &str, place: &Place, settings: Settings, emit: impl Fn(AiEvent) + Send + Sync) -> Result<String, String> {
        let mut cancel_rx = self.cancel_tx.subscribe();
        cancel_rx.mark_unchanged();
        let work = async {
            if settings.provider == "openrouter" {
                self.ask_openrouter(app, text, place, &settings, &emit).await
            } else {
                self.ask_claude_code(text, place, &settings, &emit).await
            }
        };
        tokio::select! {
            r = work => r,
            _ = cancel_rx.changed() => Err("cancelled".into()),
        }
    }

    // ------------------------------------------------------------ OpenRouter
    async fn ask_openrouter(&self, app: &AppHandle, text: &str, place: &Place, s: &Settings, emit: &(impl Fn(AiEvent) + Send + Sync)) -> Result<String, String> {
        if s.openrouter_key.trim().is_empty() {
            return Err("no openrouter key. open settings (F1) and paste one.".into());
        }
        let mut work = {
            let mut h = self.history.lock().await;
            h.push(json!({ "role": "user", "content": text }));
            let len = h.len();
            if len > 40 {
                h.drain(0..len - 40);
            }
            while h.first().is_some_and(|m| m["role"] != "user") {
                h.remove(0);
            }
            h.clone()
        };
        let system = format!("{PERSONA}\nThe person's OS is {}.\n{}", std::env::consts::OS, place.describe());
        let model = if s.openrouter_model.trim().is_empty() { "anthropic/claude-sonnet-5.5" } else { s.openrouter_model.trim() };
        let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).build().map_err(|e| e.to_string())?;

        let mut use_tools = s.device_control;
        let mut retried = false;
        for _ in 0..10 {
            let mut messages = vec![json!({ "role": "system", "content": system })];
            messages.extend(work.iter().cloned());
            let mut body = json!({ "model": model, "messages": messages, "max_tokens": 400 });
            if use_tools {
                body["tools"] = device::tool_defs();
            }
            let res = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .bearer_auth(s.openrouter_key.trim())
                .header("HTTP-Referer", "https://github.com/wypiek/User")
                .header("X-Title", "User")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("openrouter: {e}"))?;
            let status = res.status();
            let data: Value = res.json().await.unwrap_or(Value::Null);
            if !status.is_success() || data.get("error").is_some() {
                let err = openrouter_error(status, &data, model);
                // this model can't use tools: talk without them (he just can't control the device)
                if use_tools && err.to_lowercase().contains("tool") {
                    use_tools = false;
                    continue;
                }
                // a one-off hiccup at the provider: try once more
                if !retried && (status.is_server_error() || status.as_u16() == 429 || err.contains("Provider returned error")) {
                    retried = true;
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    continue;
                }
                self.history.lock().await.pop();
                return Err(err);
            }
            let msg = &data["choices"][0]["message"];
            let calls = msg["tool_calls"].as_array().cloned().unwrap_or_default();
            if calls.is_empty() {
                let reply = msg["content"].as_str().unwrap_or("").trim().to_string();
                let reply = if reply.is_empty() { "...".to_string() } else { reply };
                // only the final text goes into long-term history (tool chatter is dropped)
                self.history.lock().await.push(json!({ "role": "assistant", "content": reply }));
                return Ok(reply);
            }
            let text = msg["content"].as_str().unwrap_or("").trim();
            work.push(json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) }, "tool_calls": calls }));
            for call in &calls {
                let name = call["function"]["name"].as_str().unwrap_or("");
                let args: Value = call["function"]["arguments"].as_str().and_then(|a| serde_json::from_str(a).ok()).unwrap_or(json!({}));
                emit(AiEvent::Doing { label: device::describe(name, &args) });
                let result = device::run_tool(app, name, &args, s).await;
                let result = if result.trim().is_empty() { "(done, no output)".to_string() } else { result };
                work.push(json!({ "role": "tool", "tool_call_id": call["id"], "content": result }));
            }
        }
        let reply = "i tried... but my hands keep slipping through the glass.".to_string();
        self.history.lock().await.push(json!({ "role": "assistant", "content": reply }));
        Ok(reply)
    }

    // ----------------------------------------------------------- Claude Code
    async fn ask_claude_code(&self, text: &str, place: &Place, s: &Settings, emit: &(impl Fn(AiEvent) + Send + Sync)) -> Result<String, String> {
        let mut args: Vec<String> = vec!["-p".into(), "--output-format".into(), "stream-json".into(), "--verbose".into()];
        if let Some(id) = self.claude_session.lock().unwrap().clone() {
            args.extend(["--resume".into(), id]);
        }
        if !s.claude_model.trim().is_empty() {
            args.extend(["--model".into(), s.claude_model.trim().into()]);
        }
        if s.device_control {
            args.extend(["--allowedTools".into(), "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch".into()]);
        } else {
            args.extend(["--disallowedTools".into(), "Bash,Edit,Write".into()]);
        }
        let path = crate::locate::find_claude(&s.claude_path).ok_or_else(|| not_installed(&s.claude_path))?;

        let tz = place.time_zone.as_str();
        let mut child = spawn_claude(&path, &args, tz).map_err(not_found)?;

        let prompt = format!(
            "<character>\n{PERSONA}\nThe person's OS is {}. Their home folder is {}.\n{}\n</character>\n\nThe person says to you: {text}",
            std::env::consts::OS,
            home().display(),
            place.describe()
        );
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
            drop(stdin);
        }
        let mut stderr = child.stderr.take();
        let stderr_task = tokio::spawn(async move {
            let mut s = String::new();
            if let Some(e) = stderr.as_mut() {
                let _ = e.read_to_string(&mut s).await;
            }
            s
        });

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut lines = BufReader::new(stdout).lines();
        let mut result: Option<Value> = None;
        let read = async {
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(ev) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(id) = ev["session_id"].as_str() {
                    *self.claude_session.lock().unwrap() = Some(id.to_string());
                }
                if ev["type"] == "assistant" {
                    for part in ev["message"]["content"].as_array().into_iter().flatten() {
                        if part["type"] == "tool_use" {
                            emit(AiEvent::Doing { label: describe_claude_tool(part["name"].as_str().unwrap_or(""), &part["input"]) });
                        }
                    }
                }
                if ev["type"] == "result" {
                    result = Some(ev);
                }
            }
        };
        if tokio::time::timeout(Duration::from_secs(300), read).await.is_err() {
            let _ = child.kill().await;
            return Err("claude code took too long.".into());
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        let err_text = stderr_task.await.unwrap_or_default();

        match result {
            Some(r) if r["is_error"] != true && r["result"].is_string() => {
                let t = r["result"].as_str().unwrap_or("").trim().to_string();
                Ok(if t.is_empty() { "...".into() } else { t })
            }
            Some(r) => {
                // a stale session id is the most common cause; drop it so the next try starts fresh
                *self.claude_session.lock().unwrap() = None;
                let detail = r["result"].as_str().or(r["subtype"].as_str()).unwrap_or("error");
                Err(format!("claude code: {}", detail.chars().take(200).collect::<String>()))
            }
            None => Err(format!(
                "claude code exited ({status}). {}",
                err_text.trim().lines().last().unwrap_or("")
            )
            .trim()
            .to_string()),
        }
    }
}

fn spawn_claude(path: &std::path::Path, args: &[String], time_zone: &str) -> std::io::Result<tokio::process::Child> {
    // npm installs `claude.cmd` on Windows, which only cmd.exe can run
    let via_shell = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut cmd = if via_shell {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.arg("/d").arg("/c").arg(path);
        c
    } else {
        tokio::process::Command::new(path)
    };
    cmd.args(args)
        .current_dir(home())
        // the fuller search path, so Claude Code (and node, git... that it runs) are found
        .env("PATH", crate::locate::search_path())
        .env_remove("CLAUDECODE") // don't look like a nested Claude Code session
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // so `date` and friends inside Claude Code print the person's local time (macOS / Linux;
    // Windows tools use the system timezone already and don't understand IANA names)
    if cfg!(unix) && !time_zone.is_empty() {
        cmd.env("TZ", time_zone);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd.spawn()
}

/// One stand-alone prompt -> text, through OpenRouter (no history, no tools).
async fn complete_openrouter(prompt: &str, s: &Settings) -> Result<String, String> {
    if s.openrouter_key.trim().is_empty() {
        return Err("no openrouter key. open settings (F1) and paste one.".into());
    }
    let model = if s.openrouter_model.trim().is_empty() { "anthropic/claude-sonnet-5.5" } else { s.openrouter_model.trim() };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(240)).build().map_err(|e| e.to_string())?;
    let res = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(s.openrouter_key.trim())
        .header("HTTP-Referer", "https://github.com/wypiek/User")
        .header("X-Title", "User")
        .json(&json!({ "model": model, "messages": [{ "role": "user", "content": prompt }], "max_tokens": 8000 }))
        .send()
        .await
        .map_err(|e| format!("openrouter: {e}"))?;
    let status = res.status();
    let data: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() || data.get("error").is_some() {
        return Err(openrouter_error(status, &data, model));
    }
    Ok(data["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
}

/// One stand-alone prompt -> text, through a fresh Claude Code run with its tools switched off
/// (it doesn't touch User's ongoing conversation).
async fn complete_claude_code(prompt: &str, s: &Settings) -> Result<String, String> {
    let mut args: Vec<String> = vec![
        "-p".into(), "--output-format".into(), "json".into(),
        "--disallowedTools".into(), "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite".into(),
    ];
    if !s.claude_model.trim().is_empty() {
        args.extend(["--model".into(), s.claude_model.trim().into()]);
    }
    let path = crate::locate::find_claude(&s.claude_path).ok_or_else(|| not_installed(&s.claude_path))?;
    let mut child = spawn_claude(&path, &args, "").map_err(not_found)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let mut out = String::new();
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    if tokio::time::timeout(Duration::from_secs(300), stdout.read_to_string(&mut out)).await.is_err() {
        let _ = child.kill().await;
        return Err("claude code took too long to draw.".into());
    }
    let _ = child.wait().await;
    let v: Value = serde_json::from_str(out.trim()).map_err(|_| "claude code gave no answer.".to_string())?;
    if v["is_error"] == true {
        return Err(format!("claude code: {}", v["result"].as_str().unwrap_or("error")));
    }
    Ok(v["result"].as_str().unwrap_or("").to_string())
}

/// Pull the `<svg>...</svg>` out of the model's reply.
fn extract_svg(text: &str) -> Result<String, String> {
    let start = text.find("<svg").ok_or("the drawing came out empty.")?;
    let end = text.rfind("</svg>").ok_or("the drawing came out torn.")? + "</svg>".len();
    if end <= start {
        return Err("the drawing came out torn.".into());
    }
    Ok(text[start..end].to_string())
}

/// OpenRouter's errors, readable. Its generic "Provider returned error" hides the real reason
/// in error.metadata.raw, so that's dug out and shown too.
fn openrouter_error(status: reqwest::StatusCode, data: &Value, model: &str) -> String {
    let e = &data["error"];
    let msg = e["message"].as_str().unwrap_or("").trim().to_string();
    let provider = e["metadata"]["provider_name"].as_str().unwrap_or("");
    let raw = match &e["metadata"]["raw"] {
        Value::String(r) => serde_json::from_str::<Value>(r)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().or(v["message"].as_str()).or(v["error"].as_str()).map(String::from))
            .unwrap_or_else(|| r.clone()),
        Value::Null => String::new(),
        other => other["error"]["message"].as_str().or(other["message"].as_str()).map(String::from).unwrap_or_else(|| other.to_string()),
    };
    let raw: String = raw.trim().chars().take(220).collect();
    match status.as_u16() {
        401 => "openrouter rejected the key. check it in settings (F1).".into(),
        402 => "the openrouter key has no credits left.".into(),
        404 if !msg.to_lowercase().contains("tool") && (msg.is_empty() || msg.to_lowercase().contains("model") || msg.starts_with("No endpoints found for")) => format!("openrouter doesn't have the model \"{model}\". pick another one in settings (F1)."),
        429 => "openrouter says too many requests. wait a moment.".into(),
        _ => {
            let mut out = format!("openrouter: {}", if msg.is_empty() { format!("HTTP {status}") } else { msg });
            if !provider.is_empty() {
                out.push_str(&format!(" ({provider})"));
            }
            if !raw.is_empty() && !out.contains(&raw) {
                out.push_str(&format!(": {raw}"));
            }
            out
        }
    }
}

fn not_installed(configured: &str) -> String {
    let c = configured.trim();
    if c.is_empty() || c == "claude" {
        "i can't find claude code. i looked everywhere it usually lives. put its full path in settings (F1) - run 'which claude' (or 'where claude' on windows) in a terminal to see it.".into()
    } else {
        format!("i can't find claude code at {c}. check the path in settings (F1).")
    }
}

fn not_found(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        "claude code was not found. install it, or set its path / switch to openrouter in settings (F1).".into()
    } else {
        format!("claude code: {e}")
    }
}

fn describe_claude_tool(name: &str, input: &Value) -> String {
    let st = |k: &str| input[k].as_str().unwrap_or("").to_string();
    let file = |k: &str| st(k).rsplit(['/', '\\']).next().unwrap_or("").to_string();
    let cut = |t: String| t.chars().take(40).collect::<String>();
    match name {
        "Bash" => format!("running {}", cut(if st("description").is_empty() { st("command") } else { st("description") })),
        "Read" => format!("reading {}", file("file_path")),
        "Write" | "Edit" => format!("writing {}", file("file_path")),
        "WebFetch" => format!("looking at {}", cut(st("url").trim_start_matches("https://").trim_start_matches("http://").to_string())),
        "WebSearch" => format!("searching {}", cut(st("query"))),
        "Glob" | "Grep" => "searching files".into(),
        other => other.to_lowercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrouter_errors_show_the_real_reason() {
        let generic = json!({ "error": { "message": "Provider returned error", "code": 400, "metadata": {
            "raw": "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.1.content.0.text: text content blocks must be non-empty\"}}",
            "provider_name": "Anthropic" } } });
        let e = openrouter_error(reqwest::StatusCode::BAD_REQUEST, &generic, "anthropic/claude-sonnet-5.5");
        assert_eq!(e, "openrouter: Provider returned error (Anthropic): messages.1.content.0.text: text content blocks must be non-empty");
        let no_credits = json!({ "error": { "message": "Insufficient credits", "code": 402 } });
        assert!(openrouter_error(reqwest::StatusCode::PAYMENT_REQUIRED, &no_credits, "x").contains("no credits"));
        let no_model = json!({ "error": { "message": "No endpoints found for x/y.", "code": 404 } });
        assert!(openrouter_error(reqwest::StatusCode::NOT_FOUND, &no_model, "x/y").contains("doesn't have the model"));
    }
}
