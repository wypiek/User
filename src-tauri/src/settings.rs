//! Persistent settings, stored as JSON in the app's config folder.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "claude-code" | "openrouter"
    pub provider: String,
    pub openrouter_key: String,
    pub openrouter_model: String,
    pub claude_path: String,
    /// empty = Claude Code's default model
    pub claude_model: String,
    /// let User open apps / control the device
    pub device_control: bool,
    /// ask before User runs shell commands (OpenRouter mode)
    pub confirm_commands: bool,
    pub stt_model: String,
    /// microphone for push-to-talk ("" = the system default)
    pub mic_device: String,
    pub voice_volume: f64,
    pub ambience_volume: f64,
    pub setup_done: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            provider: "claude-code".into(),
            openrouter_key: String::new(),
            openrouter_model: "anthropic/claude-sonnet-5.5".into(),
            claude_path: "claude".into(),
            claude_model: String::new(),
            device_control: true,
            confirm_commands: true,
            stt_model: "onnx-community/whisper-base.en".into(),
            mic_device: String::new(),
            voice_volume: 0.9,
            ambience_volume: 0.35,
            setup_done: false,
        }
    }
}

pub fn load(path: &PathBuf) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &PathBuf, s: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    // the file holds an API key: keep it private to this user
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
