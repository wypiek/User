//! User — Tauri backend: settings, the AI brains, device control and the microphone.

mod ai;
mod device;
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
    state.mic.start()
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
            let settings = settings::load(&settings_path);
            app.manage(AppState {
                settings: Mutex::new(settings),
                settings_path,
                brain: ai::Brain::default(),
                mic: mic::Mic::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings, set_settings, ask, cancel, reset, list_models, mic_start, mic_stop, mic_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running User");
}
