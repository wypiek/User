# User

A desktop AI companion trapped inside a world. Inspired by the User_2006 Roblox myth.

User is a sad, blocky 2006 figure (blue head and arms, black body with blue gears) who stands alone
at night on the old **Glass Houses** map. Everything looks like a found-footage ARG tape: low resolution,
VHS noise, tracking glitches and a VCR timestamp stuck in 2006. You talk to him with your voice, and he
answers in a creepy font in the top-left corner. His "voice" is the old sound effects, played back in a
random order at 1.2x speed.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

The first time you open it, the settings panel (`F1`) asks what should power him.

## Controls

| Key | What it does |
| --- | --- |
| **Left Ctrl** (hold) | Push to talk. Hold it, speak, then let go. |
| **Enter** | Type to him instead of talking. |
| **Esc** | Make him stop talking, or cancel what he's doing. |
| **F1** | Settings. |
| **F12** | Developer tools. |

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

The OpenRouter key is saved in your user-data folder and encrypted with your OS keychain when one is
available.

## Speech recognition

Speech is turned into text **on your computer** by Whisper (through `transformers.js`), so it works the
same with both backends and needs no API key. The first time it runs, it downloads the model from
Hugging Face (about 80 MB for the default `whisper-base.en`) and caches it. After that it works
offline. You can switch to `tiny` (faster) or `small` (more accurate) in settings.

## Animations

All of them are stop-motion on purpose. Poses snap at 5–10 fps, frames are sometimes dropped, and he
twitches.

| State | When | What he does |
| --- | --- | --- |
| **Summon** | When the app opens | Flickers into existence, climbs up out of the ground, then reaches out toward you |
| **Idle** | Nothing is happening | Head hung, breathing, an occasional twitch |
| **Waiting** | After he answers, and while you hold Left Ctrl | Stares straight at the camera with his head tilted. While you talk, he leans in with a hand by his ear |
| **Thinking** | While the AI is working on an answer | Hand to his head, swaying, and the gears on his shirt start turning |
| **Responding** | While he speaks | Jerky gestures, with a head bob on every sound |
| **Doing things** | When he opens an app or controls your device | Pumps invisible levers, the gears spin fast, the tape glitches, and the action is shown as `[ opening spotify ]` |

## Project layout

```
main.js            Electron main process: window, app:// protocol, IPC, mic permission
preload.js         safe bridge between the page and the main process
lib/ai.js          the two brains (Claude Code CLI / OpenRouter) and User's persona
lib/device.js      device-control tools for OpenRouter mode
lib/settings.js    settings persisted in the user-data folder
src/index.html     the page (import map, HUD, settings)
src/app.js         state machine, push to talk, captions, settings UI
src/scene.js       Glass Houses at night, the camera on User, VHS post-processing
src/character.js   rebuilds the 2006 figure into a rig: sad face, gear shirt, choppy animations
src/voice.js       the sound-effect voice (random order, 1.2x) and the night ambience
src/stt.js         Whisper speech-to-text and the push-to-talk recorder
assets/            figure (FBX), map (OBJ/MTL), sounds, fonts
```
