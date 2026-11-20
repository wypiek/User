# User

A desktop AI companion trapped inside a world. Inspired by the User_2006 Roblox myth.

User is a sad, blocky 2006 figure (blue head and arms, black body with blue gears) who stands alone
at night on the old **Glass Houses** map. Everything looks like a found-footage ARG tape: low resolution,
scanlines, tracking glitches and a VCR timestamp stuck in 2006. You talk to him with your voice, and he
answers in plain white Comic Sans in the top-left corner (Comic Neue is bundled for systems that don't have Comic Sans). His "voice" is the old sound effects, played back in a
random order at 1.6x speed.

## Stack

- **Rust** with [Tauri 2](https://tauri.app) for the app shell and backend (`src-tauri/`). It handles both AI
  backends (it runs the Claude Code process and makes the OpenRouter HTTP calls with tool calling),
  device control, settings, and native microphone capture with `cpal`.
- **TypeScript + CSS** built with Vite for the frontend (`src/`): the three.js scene, the character rig and
  animations, the sound-effect voice, the HUD, and Whisper speech recognition (transformers.js /
  ONNX Runtime WebAssembly, which is JavaScript).

## Run it

You need [Node.js](https://nodejs.org) 20.19 or newer, [Rust](https://rustup.rs), and the
[Tauri system prerequisites](https://tauri.app/start/prerequisites/) for your OS. Windows and macOS
already have most of them. On Debian/Ubuntu, run:
`sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libasound2-dev libssl-dev`.

```bash
npm install
npm start          # dev mode (tauri dev)
npm run package    # build an installer / app bundle (tauri build)
```

The first time you open it, the settings panel (`F1`) asks what should power him.

## Controls

| Key | What it does |
| --- | --- |
| **Left Ctrl** (hold) | Push to talk. Hold it, speak, then let go. |
| **Enter** | Type to him instead of talking. |
| **Esc** | Make him stop talking, or cancel what he's doing. |
| **F1** | Settings. |
| **F3** | Show the frame rate and draw calls. |

Push to talk only works while the User window is focused.

## What powers him

You pick one of these in settings:

- **Claude Code**: uses the `claude` CLI you are already logged into. Install it from
  https://claude.com/claude-code and run `claude` once to log in. User keeps one ongoing Claude Code
  session, so he remembers the conversation. If device control is on, he can run commands and edit
  files through Claude Code's own tools (Bash, Read, Write, Edit, and web search/fetch).
- **OpenRouter**: paste an API key from https://openrouter.ai/keys and choose any model. The default is
  `anthropic/claude-sonnet-5.5`. He gets four tools: `open_app`, `open_url`, `open_path` and
  `run_command`. By default he asks you before running any shell command.

Settings, including the OpenRouter key, are saved as `settings.json` in the app's config folder. On
macOS and Linux the file can only be read by your user account.

## Speech recognition

While you hold Left Ctrl, the Rust backend records the microphone natively (`cpal`) and passes 16 kHz audio to
the frontend. There, Whisper (through `transformers.js`) turns it into text **on your computer**, so it works
the same with both backends and needs no API key. The first time it runs, it downloads the model from
Hugging Face (about 80 MB for the default `whisper-base.en`) and caches it. After that it works
offline. You can switch to `tiny` (faster) or `small` (more accurate) in settings.

## Animations

All of them run at 15 fps but stay choppy on purpose: frames are sometimes dropped, a pose sometimes
sticks for a few frames before snapping ahead, and every frame has a little jitter. The scene renders at
30 fps, so each pose lasts exactly two frames.

| State | When | What he does |
| --- | --- | --- |
| **Summon** | When the app opens | Climbs out of the ground: his hands punch through, his arms slam flat on the ground, he drags himself up in two pulls and steps out (dirt flies, a hole tears open, the camera rumbles). Then he stands hunched, his head snaps up at you, and he reaches out toward you |
| **Idle** | Nothing is happening | Head hung, breathing, slow slumps. Every few seconds he does something on his own: looks around, glances behind him, sighs, looks at his hands, looks up, stares at you, shifts his weight, scratches his head |
| **Waiting** | After he answers, and while you hold Left Ctrl | Stares straight at the camera with his head tilted. While you talk, he leans in with a hand by his ear |
| **Thinking** | While the AI is working on an answer | Hand to his head, swaying, and the gears on his shirt start turning |
| **Responding** | While he speaks | His head bobs on every sound, and his gestures come from his words: he points at you on "you", puts a hand on his chest on "I", shrugs at a question, shakes his head on "no", hugs himself on "alone" or "dark", and nods on "yes" |
| **Doing things** | When he opens an app or controls your device | Pumps invisible levers, the gears spin fast, the tape glitches, and the action is shown under him, e.g. `opening spotify` |

## Project layout

```
src-tauri/src/lib.rs        Tauri commands: settings, ask/cancel/reset, models, mic start/stop
src-tauri/src/ai.rs         the two brains (Claude Code process / OpenRouter + tools) and User's persona
src-tauri/src/device.rs     device-control tools (open apps/URLs/files, run commands with confirmation)
src-tauri/src/mic.rs        push-to-talk microphone capture + resampling to 16 kHz (cpal)
src-tauri/src/settings.rs   settings persisted in the config folder
src/main.ts                 state machine, push to talk, captions, settings UI
src/scene.ts                Glass Houses at night, the camera on User, VHS post-processing
src/character.ts            rebuilds the 2006 figure into a rig: sad face, gear shirt, choppy animations
src/voice.ts                the sound-effect voice (random order, 1.6x) and the night ambience
src/stt.ts                  Whisper speech-to-text
src/bridge.ts               typed wrappers around the Rust commands
src/styles.css              HUD, captions, settings
public/assets/              figure (FBX), map (OBJ/MTL), sounds, fonts
```
