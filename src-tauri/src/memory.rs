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
    /// the last subjects he drew (newest last), so random picks don't repeat
    #[serde(default)]
    pub recent_subjects: Vec<String>,
}

// ---- random subjects: when nobody says what to draw, every drawing is something new
const SUBJECTS: &[&str] = &[
    "a fox", "a lighthouse", "a hot air balloon", "a whale", "a little robot", "a cactus in a pot", "an owl on a branch",
    "a sailboat", "a castle", "a snowman", "a frog on a lily pad", "a cup of tea", "a friendly dragon", "a bicycle",
    "a mushroom house", "a jellyfish", "a penguin", "a rocket ship", "a sunflower", "a turtle", "a steam train",
    "a teddy bear", "a treehouse", "a koala", "an octopus", "a guitar", "a dinosaur", "a yellow submarine", "a windmill",
    "a butterfly", "a hedgehog", "a volcano", "a cozy cabin", "a birthday cake", "a pirate ship", "a giraffe", "a bunny",
    "an astronaut", "a campfire", "a goldfish bowl", "a kite", "a ladybug", "a polar bear", "an ice cream cone", "a parrot",
    "a waterfall", "a crab", "a city skyline", "a deer", "a sleepy cat", "a happy dog", "a horse", "a bee and flowers",
    "a snail", "a tree", "a ferris wheel", "a paper lantern", "a bird's nest with eggs", "a mountain lake", "a seal",
    "a basket of strawberries", "a red bus", "a teapot", "a squirrel with an acorn", "a duck", "a blocky figure waving hello",
    "a flower in a vase", "a lion", "an elephant", "a panda eating bamboo", "a pumpkin", "a rainbow over hills",
];
const SETTINGS: &[&str] = &[
    "at sunset", "in the snow", "under a starry sky", "on a sunny day", "in the rain", "by the sea", "in a field of flowers",
    "on a grassy hill", "in outer space", "in a forest", "at night under a big moon", "among the clouds", "on a windowsill",
    "in a garden", "underwater", "in autumn leaves", "in the desert", "on a little island",
];

/// A small, dependency-free random number generator, seeded from the clock.
struct Rng(u64);
impl Rng {
    fn new() -> Self {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        Rng(t ^ ((std::process::id() as u64) << 32) | 1)
    }
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize { (self.next() % n as u64) as usize }
}

/// "draw something", "surprise me", "" ... -> no real subject was given.
pub fn is_vague(subject: &str) -> bool {
    let t: String = subject.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '\'').collect();
    let t = t.split_whitespace().filter(|w| !["me", "us", "please", "pls", "for", "a", "an", "just"].contains(w)).collect::<Vec<_>>().join(" ");
    t.is_empty()
        || [
            "random", "something", "anything", "whatever", "picture", "drawing", "you choose", "your choice", "surprise",
            "surprise me", "something nice", "something cool", "something random", "something else", "anything you want",
            "whatever you want", "anything you like", "whatever you like", "up to you", "something new", "doodle",
        ]
        .contains(&t.as_str())
}

/// A random subject he hasn't drawn recently.
pub fn random_subject(m: &Memory) -> String {
    let mut rng = Rng::new();
    let recent: Vec<String> = m.recent_subjects.iter().rev().take(20).map(|s| s.to_lowercase()).collect();
    let fresh: Vec<&&str> = SUBJECTS.iter().filter(|s| !recent.iter().any(|r| r.contains(&s.to_lowercase()))).collect();
    let pool: Vec<&&str> = if fresh.is_empty() { SUBJECTS.iter().collect() } else { fresh };
    let subject = pool[rng.below(pool.len())];
    // most of the time, put it somewhere too
    if rng.below(10) < 7 {
        format!("{subject} {}", SETTINGS[rng.below(SETTINGS.len())])
    } else {
        subject.to_string()
    }
}

/// Note what he drew (for the no-repeats rule).
pub fn remember_subject(m: &mut Memory, subject: &str) {
    m.recent_subjects.push(subject.chars().take(200).collect());
    let len = m.recent_subjects.len();
    if len > 30 {
        m.recent_subjects.drain(0..len - 30);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vague_requests_get_a_random_subject() {
        for s in ["", "random", "something", "me something", "Something!", "surprise me", "anything you want", "a picture", "up to you"] {
            assert!(is_vague(s), "{s:?} should be vague");
        }
        for s in ["a cat", "a cat under the moon", "my dog", "something with cats", "a dragon"] {
            assert!(!is_vague(s), "{s:?} names a subject");
        }
    }

    #[test]
    fn random_subjects_vary_and_avoid_recent_ones() {
        let mut m = Memory::default();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..25 {
            let s = random_subject(&m);
            // the base subject must not be one of the last 20 drawn
            let base = SUBJECTS.iter().find(|b| s.starts_with(**b)).expect("from the list");
            assert!(!m.recent_subjects.iter().rev().take(20).any(|r| r.to_lowercase().contains(*base)), "{s} repeats a recent subject");
            seen.insert(s.clone());
            remember_subject(&mut m, &s);
            std::thread::sleep(std::time::Duration::from_micros(50));
        }
        assert_eq!(seen.len(), 25, "25 drawings in a row should all be different");
        assert!(m.recent_subjects.len() <= 30);
    }
}
