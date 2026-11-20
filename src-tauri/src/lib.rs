//! User — Tauri backend: settings, the AI brains, device control and the microphone.

mod ai;
mod device;
mod locate;
mod memory;
mod mic;
mod settings;

use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State};

struct AppState {
    settings: Mutex<settings::Settings>,
    settings_path: PathBuf,
    memory_path: PathBuf,
    brain: ai::Brain,
    mic: mic::Mic,
}

fn view(s: &settings::Settings) -> Value {
    let mut v = serde_json::to_value(s).unwrap_or_default();
    v["platform"] = std::env::consts::OS.into();
    v
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Value {
    view(&state.settings.lock().unwrap())
}

#[tauri::command]
async fn set_settings(state: State<'_, AppState>, next: Value) -> Result<Value, String> {
    let (merged, provider_changed) = {
        let cur = state.settings.lock().unwrap().clone();
        let mut v = serde_json::to_value(&cur).map_err(|e| e.to_string())?;
        if let (Some(obj), Some(n)) = (v.as_object_mut(), next.as_object()) {
            for (k, val) in n {
                if obj.contains_key(k) {
                    obj.insert(k.clone(), val.clone());
                }
            }
        }
        let merged: settings::Settings = serde_json::from_value(v).map_err(|e| e.to_string())?;
        let changed = merged.provider != cur.provider;
        (merged, changed)
    };
    settings::save(&state.settings_path, &merged)?;
    *state.settings.lock().unwrap() = merged.clone();
    if provider_changed {
        state.brain.reset().await;
    }
    Ok(view(&merged))
}

#[tauri::command]
async fn ask(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    place: Option<ai::Place>,
    on_event: Channel<ai::AiEvent>,
) -> Result<String, String> {
    let settings = state.settings.lock().unwrap().clone();
    let text: String = text.chars().take(8000).collect();
    state
        .brain
        .ask(&app, &text, &place.unwrap_or_default(), settings, move |ev| {
            let _ = on_event.send(ev);
        })
        .await
}

#[derive(serde::Serialize)]
struct Drawn {
    subject: String,
    svg: String,
}

/// Have User make a drawing. With no real subject ("", "something", "surprise me") he picks
/// a random one he hasn't drawn recently. Returns what he drew and its SVG strokes.
#[tauri::command]
async fn draw(state: State<'_, AppState>, subject: String) -> Result<Drawn, String> {
    let settings = state.settings.lock().unwrap().clone();
    let mut mem = memory::load(&state.memory_path);
    let subject: String = subject.trim().chars().take(400).collect();
    let subject = if memory::is_vague(&subject) { memory::random_subject(&mem) } else { subject };
    memory::remember_subject(&mut mem, &subject);
    let _ = memory::save(&state.memory_path, &mem);
    let lessons = memory::drawing_lessons(&mem);
    let svg = state.brain.draw(&subject, &lessons, settings).await?;
    Ok(Drawn { subject, svg })
}

/// Remember how the person felt about a drawing, so the next ones get better.
#[tauri::command]
fn drawing_feedback(state: State<'_, AppState>, subject: String, liked: bool, note: String) -> Result<(), String> {
    let mut m = memory::load(&state.memory_path);
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    m.drawings.push(memory::DrawingNote {
        subject: subject.chars().take(200).collect(),
        liked,
        note: note.chars().take(500).collect(),
        at,
    });
    let len = m.drawings.len();
    if len > 200 {
        m.drawings.drain(0..len - 200);
    }
    memory::save(&state.memory_path, &m)
}

/// Save a finished drawing (PNG bytes) into Pictures/User and return where it went.
#[tauri::command]
fn save_drawing(app: AppHandle, png: Vec<u8>, subject: String) -> Result<String, String> {
    if !png.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("not a png".into());
    }
    let base = app.path().picture_dir().or_else(|_| app.path().home_dir()).map_err(|e| e.to_string())?;
    let dir = base.join("User");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let slug: String = subject
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|w| !w.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = dir.join(format!("drawing-{secs}-{}.png", if slug.is_empty() { "untitled" } else { &slug }));
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn cancel(state: State<'_, AppState>) {
    state.brain.cancel();
}

#[tauri::command]
async fn reset(state: State<'_, AppState>) -> Result<(), String> {
    state.brain.reset().await;
    Ok(())
}

#[tauri::command]
async fn list_models() -> Vec<String> {
    let Ok(res) = reqwest::get("https://openrouter.ai/api/v1/models").await else { return vec![] };
    let data: Value = res.json().await.unwrap_or_default();
    let mut ids: Vec<String> = data["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().map(String::from))
        .collect();
    ids.sort();
    ids
}

#[tauri::command]
fn mic_start(state: State<'_, AppState>) -> Result<(), String> {
    let device = state.settings.lock().unwrap().mic_device.clone();
    state.mic.start(&device)
}

/// The microphones / input devices on this computer, for the settings menu.
#[tauri::command]
fn list_mics() -> Vec<String> {
    mic::input_devices()
}

/// Returns raw little-endian f32 samples (16 kHz mono) as an ArrayBuffer.
#[tauri::command]
fn mic_stop(state: State<'_, AppState>) -> Result<Response, String> {
    let samples = state.mic.stop()?;
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    Ok(Response::new(bytes))
}

#[tauri::command]
fn mic_cancel(state: State<'_, AppState>) {
    state.mic.cancel();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let settings_path = dir.join("settings.json");
            let memory_path = dir.join("memory.json");
            let settings = settings::load(&settings_path);
            app.manage(AppState {
                settings: Mutex::new(settings),
                settings_path,
                memory_path,
                brain: ai::Brain::default(),
                mic: mic::Mic::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings, set_settings, ask, cancel, reset, list_models, mic_start, mic_stop, mic_cancel,
            draw, drawing_feedback, save_drawing, list_mics
        ])
        .run(tauri::generate_context!())
        .expect("error while running User");
}
