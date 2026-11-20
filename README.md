# User

A desktop AI companion trapped inside a world. Inspired by the User_2006 Roblox myth.

User is a sad, blocky 2006 figure (blue head and arms, black body with blue gears) who stands alone
at night on the old **Glass Houses** map. Everything looks like a found-footage ARG tape: low resolution,
scanlines and tracking glitches, with nothing on screen but him and his words. You talk to him with your voice, and he
answers in the top-left corner in a squished, white pixel font (VT323), like the on-screen text of an old tape. His "voice" is the old sound effects, played back in a
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

User opens in a normal, resizable window (not fullscreen). The default size is **1024×576**: 16:9 like a video, and
small enough to fit a 1366×768 laptop screen with its title bar and taskbar. On a 1440p or 4K monitor,
**1280×720** or **1600×900** look good too; drag the window edge to resize. The smallest it can go is 640×360.

## Installers

[`.github/workflows/build-installers.yml`](.github/workflows/build-installers.yml) builds installers on GitHub Actions:

| Platform | File | Notes |
| --- | --- | --- |
| Windows (x64) | `User_<version>_x64-setup.exe`, `User_<version>_x64_en-US.msi` | Installs WebView2 if it's missing |
| macOS (Universal: Apple Silicon + Intel) | `User_<version>_universal.dmg` | Ad-hoc signed, not notarized: the first time, right-click the app and choose **Open** |
| Linux (x86_64 and arm64) | `User_<version>_amd64.AppImage`, `User_<version>_aarch64.AppImage` | Bundles GStreamer so his voice plays on any distro. Run `chmod +x` on the file, then start it |

- **Pull requests to `main`** and **manual runs** (Actions → Build installers → Run workflow) upload the installers as
  workflow artifacts.
- **Pushing a version tag** (e.g. `git tag v2.1.0 && git push origin v2.1.0`) also attaches them to a draft GitHub
  Release, so you can review it before publishing.

## Controls

| Key | What it does |
| --- | --- |
| **Left Ctrl** (hold) | Push to talk. Hold it, speak, then let go. |
| **Enter** | Type to him instead of talking. |
| **Esc** | Make him stop talking, or cancel what he's doing. |
| **Click him** | He gets shoved: "ouch", he staggers back, shakes his head and brushes himself off. |
| **F1** | Settings. |
| **F3** | Show the frame rate and draw calls. |

Push to talk only works while the User window is focused.

## What powers him

You pick one of these in settings:

- **Claude Code**: uses the `claude` CLI you are already logged into. Install it from
  https://claude.com/claude-code and run `claude` once to log in. User keeps one ongoing Claude Code
  session, so he remembers the conversation. If device control is on, he can run commands and edit
  files through Claude Code's own tools (Bash, Read, Write, Edit, and web search/fetch).
  The app finds `claude` even when it isn't on the PATH an app gets from the Dock or Start menu: it uses your login
  shell's PATH and checks the usual install folders (`~/.local/bin`, `~/.claude/local`, Homebrew, npm's global
  folder, nvm, volta, bun). If it still can't find it, put the full path in **Path to claude** in settings
  (`which claude` or `where claude` in a terminal shows it).
- **OpenRouter**: paste an API key from https://openrouter.ai/keys and choose any model. The default is
  `anthropic/claude-sonnet-5.5`. He gets four tools: `open_app`, `open_url`, `open_path` and
  `run_command`. By default he asks you before running any shell command.

**Your timezone and country:** with every message, the app tells him your timezone (e.g. `Europe/Warsaw`), UTC offset,
local date and time, and your computer's region setting. He works out your country from that and always gives times in
your local timezone, never UTC. This is read from your own system settings, with no location lookup over the internet.
For Claude Code on macOS and Linux, the `TZ` variable is also set to your timezone, so commands like `date` print your
local time.

Settings, including the OpenRouter key, are saved as `settings.json` in the app's config folder. On
macOS and Linux the file can only be read by your user account.

## Speech recognition

While you hold Left Ctrl, the Rust backend records the microphone natively (`cpal`) and passes 16 kHz audio to
the frontend. There, Whisper (through `transformers.js`) turns it into text **on your computer**, so it works
the same with both backends and needs no API key. The first time it runs, it downloads the model from
Hugging Face (about 80 MB for the default `whisper-base.en`) and caches it. After that it works
offline. You can switch to `tiny` (faster) or `small` (more accurate) in settings.

Pick which microphone to use under **Sound → Microphone** in settings (`F1`). The list refreshes each time you open
settings; **System default** follows your OS setting, and if a chosen microphone is unplugged it falls back to the
default.

## Drawing

Ask him to draw something ("can you draw me a cat under the moon?"), or describe a picture you want, and he draws it
**by hand** in his own little paint program, `userpaint`. Nothing is image-generated. The AI writes the drawing as a
list of simple shapes (a tiny SVG), and the paint program ([`src/paint.ts`](src/paint.ts)) traces every outline with
a pen and colours every shape in with marker hatching, stroke by stroke, onto a notebook page. It only reads shape
geometry and colours from the SVG: nothing from it is ever put into the page as markup.

1. He takes a notebook from behind his back and a pen from his pocket, then thinks with the pen on his chin while the
   AI works out the strokes.
2. He draws. The ink goes onto the page he's holding.
3. He clicks the pen, puts it away, holds the notebook up with its back to you and asks if you want to see it.
   - **Yes:** he turns it around and the `userpaint.exe` window pops up with a sharp copy (it has a **Save** button,
     which saves to `Pictures/User`). Then he asks if you like it.
   - **No:** he throws it up in the air and it explodes into paper scraps.
4. Do you like it?
   - **Yes:** he's flattered. Every few minutes after that, he may offer to draw you something else.
   - **No:** he asks what he should do better, unless you already said why. He remembers it.

What you say about each drawing is saved in `memory.json` in the app's config folder. Every new drawing request
includes those notes, so his drawings follow what you liked and avoid what you didn't. Press **Esc** while he's
drawing to make him stop.

## Animations

All of them run at 15 fps but stay choppy on purpose: frames are sometimes dropped, a pose sometimes
sticks for a few frames before snapping ahead, and every frame has a little jitter. Only User is choppy:
the app itself renders as fast as your display refreshes (60 fps and up), capped at 240 fps. Press F3 to
see the actual frame rate.

On top of the keyed poses, every joint has a little **follow-through**: it chases its pose like a damped spring that
only moves on the 15 fps steps, so moves overshoot slightly and settle, and his head trails his body.

| State | When | What he does |
| --- | --- | --- |
| **Summon** | When the app opens | Climbs out of the ground: his hands punch through, his arms slam flat on the ground, he drags himself up in two pulls and steps out (dirt flies, a hole tears open, the camera rumbles). Then he stands hunched, his head snaps up at you, and he reaches out toward you |
| **Idle** | Nothing is happening | Head hung, weight shifting from hip to hip, slow slumps. Every few seconds he does something on his own: looks around, glances behind him, sighs, looks at his hands, looks up, stares at you, shifts his weight, scratches his head, creeps a few steps toward the camera to stare at you, stretches, shivers, kicks at the dirt, peeks past the camera, or glitches for a few frames |
| **Waiting** | After he answers, and while you hold Left Ctrl | Stares straight at the camera with his head tilted; sometimes waves, peers, creeps closer, peeks past the camera, shivers or glitches. While you talk, he leans in with a hand by his ear |
| **Thinking** | While the AI is working on an answer | Hand to his head, swaying, pacing, looking up, tapping his foot, and the gears on his shirt start turning |
| **Responding** | While he speaks | His head bobs on every sound, and his gestures come from his words, each with a little wind-up: he waves on "hi", points at you on "you", puts a hand on his chest on "I", shrugs at a question, shakes his head on "no", hugs himself on "alone" or "dark", shivers on "cold" or "scared", points up at "sky" or "stars" and down at "ground", spreads his arms on "big" or "everything", holds his hands close on "little", puts a hand to his chin on "maybe" or "think", and nods on "yes" |
| **Doing things** | When he opens an app or controls your device | Pumps invisible levers, types on an invisible keyboard, turns a crank, slams a big button; the gears spin fast and the tape glitches |
| **Drawing** | You ask for a drawing | Takes out a notebook and pen, thinks, draws, clicks the pen and puts it away, holds the drawing up, then turns it around, gets flattered or sad, or throws it up so it explodes (see [Drawing](#drawing)) |
| **Poked** | You click him (any time after he's out of the ground) | The "ouch" sound plays, he's knocked back a step with his arms flung out, catches himself, shakes his head, brushes off his chest with each hand and dusts off his legs, then steps back to his spot |

## Project layout

```
src-tauri/src/lib.rs        Tauri commands: settings, ask/cancel/reset, models, mic start/stop
src-tauri/src/ai.rs         the two brains (Claude Code process / OpenRouter + tools) and User's persona
src-tauri/src/device.rs     device-control tools (open apps/URLs/files, run commands with confirmation)
src-tauri/src/memory.rs     what he remembers about your opinion of his drawings
src-tauri/src/mic.rs        push-to-talk microphone capture + resampling to 16 kHz (cpal)
src-tauri/src/settings.rs   settings persisted in the config folder
src/main.ts                 state machine, push to talk, captions, settings UI
src/scene.ts                Glass Houses at night, the camera on User, VHS post-processing
src/character.ts            rebuilds the 2006 figure into a rig: sad face, gear shirt, choppy animations
src/paint.ts                userpaint: traces the AI's drawing by hand onto the notebook page
src/voice.ts                the sound-effect voice (random order, 1.6x) and the night ambience
src/stt.ts                  Whisper speech-to-text
src/bridge.ts               typed wrappers around the Rust commands
src/styles.css              HUD, captions, settings
public/assets/              figure (FBX), map (OBJ/MTL), sounds, fonts
```
