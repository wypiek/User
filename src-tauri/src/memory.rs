//! What User remembers between sessions: how the person felt about his drawings,
//! so every new drawing can learn from the old ones.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DrawingNote {
    pub subject: String,
    pub liked: bool,
    /// what the person said about it ("the cat's legs look weird"), if anything
    #[serde(default)]
    pub note: String,
    /// unix seconds
    #[serde(default)]
    pub at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Memory {
    #[serde(default)]
    pub drawings: Vec<DrawingNote>,
}

pub fn load(path: &PathBuf) -> Memory {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(path: &PathBuf, m: &Memory) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, serde_json::to_string_pretty(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// The lessons from earlier drawings, written for the drawing prompt (newest last).
pub fn drawing_lessons(m: &Memory) -> String {
    let recent: Vec<&DrawingNote> = m.drawings.iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
    if recent.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "What the person told you about your earlier drawings. Learn from it: do more of what they liked, and fix what they disliked.\n",
    );
    for d in recent {
        let verdict = if d.liked { "LIKED" } else { "did NOT like" };
        if d.note.trim().is_empty() {
            out.push_str(&format!("- They {verdict} your drawing of \"{}\".\n", d.subject));
        } else {
            out.push_str(&format!("- They {verdict} your drawing of \"{}\". They said: \"{}\"\n", d.subject, d.note.trim()));
        }
    }
    out
}
