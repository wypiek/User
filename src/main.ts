// User — frontend: wires the world, the character, his voice, his ears and his brain (Rust).
import * as THREE from 'three';
import { World } from './scene';
import { loadCharacter, type Character } from './character';
import { Voice } from './voice';
import { loadSTT, transcribe } from './stt';
import { bridge, type Settings } from './bridge';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  caption: $('caption'), typebox: $<HTMLInputElement>('typebox'), settings: $('settings'),
  boot: $('boot'), bootDetail: $('boot-detail'),
};

type Mode = 'booting' | 'summon' | 'idle' | 'listening' | 'transcribing' | 'thinking' | 'doing' | 'responding' | 'waiting';

let settings: Settings;
let world: World;
let user: Character;
let voice: Voice;
let mode: Mode = 'booting';
let idleTimer: number | undefined;
let captionTimer: number | undefined;
let sttReady = false;
let sttError: unknown = null;
let summonStartedAt = 0;
let ptt = { down: false, combo: false, recording: false };

// ------------------------------------------------------------------ boot
async function boot() {
  settings = await bridge.getSettings();
  world = new World($<HTMLCanvasElement>('stage'));
  voice = new Voice('/assets/sounds/');
  voice.setVolumes(settings.voiceVolume, settings.ambienceVolume);

  ui.bootDetail.textContent = 'loading';
  const [, character] = await Promise.all([
    world.loadMap('/assets/models/map/', 'glasshousesmap.mtl', 'glasshousesmap.obj', (e) => {
      if (e.lengthComputable) ui.bootDetail.textContent = `loading ${Math.round((e.loaded / e.total) * 100)}%`;
    }),
    loadCharacter('/assets/models/figure/2006Figure.fbx'),
    voice.load(),
  ]);
  user = character;
  world.addCharacter(user);
  user.onStateEnd = (ended) => { if (ended === 'summon') afterSummon(); };

  startLoop();
  ui.boot.classList.add('gone');
  summon();
}

function summon() {
  mode = 'summon';
  user.setState('summon', { force: true });
  world.glitch = 0.5;
  summonStartedAt = performance.now();
  voice.startAmbience();
  // sounds land on the beats of the climb: hands break through, arms slam down,
  // two pulls, the leg comes out, then his head snaps up at you
  const hit = (ms: number, name: Parameters<Voice['play']>[0], rate: number, gain: number) =>
    setTimeout(() => voice.play(name, { rate, gain }), ms);
  hit(350, 'glass', 0.75, 0.8);
  hit(750, 'ball', 0.55, 0.9);
  hit(1350, 'splat', 0.6, 0.7);
  hit(1800, 'splat', 0.5, 0.7);
  hit(2050, 'ball', 0.7, 0.6);
  hit(2750, 'press', 0.6, 0.7);
}

function afterSummon() {
  mode = 'idle';
  user.setState('idle');
  preloadEars();
  if (!settings.setupDone) setTimeout(openSettings, 600);
}

function preloadEars() {
  sttReady = false;
  sttError = null;
  loadSTT(settings.sttModel)
    .then(() => { sttReady = true; })
    .catch((e) => { sttError = e; console.error('speech model failed', e); });
}

// ------------------------------------------------------------------ loop
function startLoop() {
  const t0 = performance.now();
  let last = t0;
  // The app renders as fast as the display refreshes (60 Hz and up), capped at 240 fps.
  // Only User himself is choppy: his poses still step at 15 fps (see character.ts).
  const MIN_FRAME_MS = 1000 / 240;
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    if (now - last < MIN_FRAME_MS - 0.25) return; // faster than 240 Hz: skip this one
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    user.update(dt);
    // glitch intensity follows his state
    const targets: Partial<Record<Mode, number>> = { summon: 0.25, doing: 0.35, thinking: 0.12, listening: 0.05, transcribing: 0.1 };
    world.glitch += ((targets[mode] ?? 0.02) - world.glitch) * Math.min(1, dt * 2);
    // the ground rumbles while he climbs out, and goes still when he looks at you
    world.shake = mode === 'summon' && now - summonStartedAt < 2400 ? 1 : Math.max(0, world.shake - dt * 3);
    if (Math.random() < dt * 0.06) world.glitch = 0.9; // the tape catches (~once every 17 s, at any frame rate)
    world.render((now - t0) / 1000);
    fpsFrames++;
  };
  requestAnimationFrame(frame);
  setInterval(() => {
    if (showFps) $('fps').textContent = `${fpsFrames} fps · ${world.renderer.info.render.calls} draw calls`;
    fpsFrames = 0;
  }, 1000);
}

let fpsFrames = 0;
let showFps = false;

// ------------------------------------------------------------------ states
function setMode(m: Mode) {
  mode = m;
  clearTimeout(idleTimer);
  user.ctx.listening = m === 'listening';
  switch (m) {
    case 'listening': user.setState('waiting', { force: true }); break;
    case 'transcribing': user.setState('waiting'); break;
    case 'thinking': user.setState('thinking'); break;
    case 'doing': user.setState('doing'); break;
    case 'responding': user.setState('responding'); break;
    case 'waiting':
      user.setState('waiting', { force: true });
      idleTimer = window.setTimeout(() => setMode('idle'), 15000);
      break;
    case 'idle': user.setState('idle'); break;
    default: break;
  }
}

const busy = () => (['thinking', 'doing', 'transcribing', 'summon', 'booting'] as Mode[]).includes(mode);

// ------------------------------------------------------------------ talking to him
async function handleUserText(raw: string) {
  const text = raw.trim();
  if (!text) return setMode('waiting');
  setMode('thinking');
  const res = await bridge.ask(text, (ev) => {
    if (ev.type === 'doing' && (mode === 'thinking' || mode === 'doing')) setMode('doing');
  });
  if (mode !== 'thinking' && mode !== 'doing') return; // cancelled
  if (!res.ok) return say(`...something is wrong. ${res.error}`);
  return say(shorten(cleanReply(res.text)));
}

function cleanReply(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|\*|#+\s/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim() || '...';
}

/** Hard limit on how much he says: at most 2 sentences / 30 words, cut at a sentence end. */
function shorten(text: string, maxWords = 30, maxSentences = 2): string {
  // split after a single . ! or ? — his trailing "..." pauses don't end a sentence
  const sentences = text.split(/(?<=(?:^|[^.])[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  if (!sentences.length) return text;
  let out = '';
  for (const sentence of sentences.slice(0, maxSentences)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.split(/\s+/).length > maxWords) break;
    out = next;
  }
  if (!out) out = sentences[0].split(/\s+/).slice(0, maxWords).join(' ') + '...';
  return out;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function say(text: string) {
  setMode('responding');
  clearTimeout(captionTimer);
  ui.caption.className = '';
  ui.caption.textContent = '';
  await voice.speak(text, {
    onChunk: (soFar) => {
      user.speakChunk(soFar.slice(ui.caption.textContent?.length ?? 0));
      ui.caption.textContent = soFar;
    },
  });
  if (mode !== 'responding') return;
  const words = text.split(/\s+/).length;
  captionTimer = window.setTimeout(() => ui.caption.classList.add('fade'), Math.max(7000, words * 450));
  setMode('waiting');
}

// ------------------------------------------------------------------ push to talk: LEFT CONTROL
async function startListening() {
  if (busy()) return;
  voice.stop();
  ptt = { down: true, combo: false, recording: false };
  setMode('listening');
  try {
    await bridge.micStart(); // captured natively in Rust
    ptt.recording = true;
    if (!ptt.down) { await bridge.micCancel(); ptt.recording = false; setMode('waiting'); } // released before the mic opened
  } catch (e) {
    ptt.down = false;
    console.error('microphone', e);
    void say("...i can't hear you. there's no microphone.");
  }
}

async function finishListening() {
  if (!ptt.down) return;
  ptt.down = false;
  if (!ptt.recording) return; // startListening will clean up
  ptt.recording = false;
  if (ptt.combo) { await bridge.micCancel(); setMode('waiting'); return; }
  setMode('transcribing');
  try {
    const pcm = await bridge.micStop();
    const text = await transcribe(pcm, settings.sttModel);
    if (!text) { void say('...what? i didn\'t hear anything.'); return; }
    await handleUserText(text);
  } catch (e) {
    console.error(e);
    void say(sttReady && !sttError ? '...the static ate your words. try again.' : "...my ears aren't working. type to me instead.");
  }
}

function stopHim() {
  if (mode === 'responding') { voice.stop(); setMode('waiting'); }
  else if (mode === 'thinking' || mode === 'doing') { void bridge.cancel(); void say('...fine.'); }
}

// ------------------------------------------------------------------ clicking him
const pointer = new THREE.Vector2();
const ray = new THREE.Raycaster();
function overUser(e: PointerEvent | MouseEvent): boolean {
  if (!user || !world) return false;
  const r = world.renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(pointer, world.camera);
  return user.hitBy(ray);
}
const stage = $<HTMLCanvasElement>('stage');
stage.addEventListener('pointermove', (e) => { stage.style.cursor = mode !== 'summon' && overUser(e) ? 'pointer' : ''; });
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !overUser(e)) return;
  voice.resume();
  if (!user.poke()) return;
  voice.play('ouch', { rate: 1, gain: 1 });
  world.glitch = Math.max(world.glitch, 0.6); // the tape jolts
});

window.addEventListener('keydown', (e) => {
  voice?.resume();
  if (!ui.settings.hidden) { if (e.key === 'Escape') closeSettings(); return; }
  if (e.key === 'F1') { e.preventDefault(); openSettings(); return; }
  if (e.key === 'F3') { e.preventDefault(); showFps = !showFps; $('fps').textContent = ''; return; }
  if (!user) return;
  const typing = document.activeElement === ui.typebox;
  if (e.code === 'ControlLeft') {
    if (!e.repeat && !typing && !ptt.down) void startListening();
    return;
  }
  if (ptt.down) { ptt.combo = true; return; } // Ctrl+<key> shortcut, not push-to-talk
  if (typing) {
    if (e.key === 'Enter') {
      const v = ui.typebox.value;
      ui.typebox.value = '';
      closeTypebox();
      if (!busy() && v.trim()) { voice.stop(); void handleUserText(v); }
    } else if (e.key === 'Escape') closeTypebox();
    return;
  }
  if (e.key === 'Enter' && mode !== 'summon' && mode !== 'booting') { e.preventDefault(); openTypebox(); }
  else if (e.key === 'Escape') stopHim();
});
window.addEventListener('keyup', (e) => { if (e.code === 'ControlLeft') void finishListening(); });
window.addEventListener('blur', () => { if (ptt.down) void finishListening(); });

function openTypebox() { ui.typebox.classList.add('open'); ui.typebox.focus(); }
function closeTypebox() { ui.typebox.classList.remove('open'); ui.typebox.blur(); }

// ------------------------------------------------------------------ settings
const form = {
  claudePath: $<HTMLInputElement>('claudePath'), claudeModel: $<HTMLInputElement>('claudeModel'),
  openrouterKey: $<HTMLInputElement>('openrouterKey'), openrouterModel: $<HTMLInputElement>('openrouterModel'),
  deviceControl: $<HTMLInputElement>('deviceControl'), confirmCommands: $<HTMLInputElement>('confirmCommands'),
  voiceVolume: $<HTMLInputElement>('voiceVolume'), ambienceVolume: $<HTMLInputElement>('ambienceVolume'),
  sttModel: $<HTMLSelectElement>('sttModel'),
};
type FormKey = keyof typeof form;

const providerRadios = () => [...document.querySelectorAll<HTMLInputElement>('input[name=provider]')];

function syncProviderFieldsets() {
  const p = providerRadios().find((r) => r.checked)?.value;
  document.querySelectorAll<HTMLElement>('#settings [data-for]').forEach((f) => f.classList.toggle('off', f.dataset.for !== p));
}

let modelsLoaded = false;
function openSettings() {
  for (const [k, el] of Object.entries(form) as [FormKey, HTMLInputElement | HTMLSelectElement][]) {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!settings[k];
    else el.value = String(settings[k] ?? '');
  }
  providerRadios().forEach((r) => { r.checked = r.value === settings.provider; });
  syncProviderFieldsets();
  ui.settings.hidden = false;
  document.body.classList.add('cfg');
  if (!modelsLoaded) {
    modelsLoaded = true;
    void bridge.listModels().then((ids) => { $('models').innerHTML = ids.map((id) => `<option value="${escapeHtml(id)}">`).join(''); });
  }
}
function closeSettings() { ui.settings.hidden = true; document.body.classList.remove('cfg'); }

providerRadios().forEach((r) => r.addEventListener('change', syncProviderFieldsets));
const previewVolumes = () => voice?.setVolumes(+form.voiceVolume.value, +form.ambienceVolume.value);
form.voiceVolume.addEventListener('input', previewVolumes);
form.ambienceVolume.addEventListener('input', previewVolumes);
$('gear').addEventListener('click', openSettings);
$('cancelSettings').addEventListener('click', () => { voice?.setVolumes(settings.voiceVolume, settings.ambienceVolume); closeSettings(); });
$('forget').addEventListener('click', async () => {
  await bridge.reset();
  ui.caption.textContent = '';
  closeSettings();
});
$('saveSettings').addEventListener('click', async () => {
  const next: Record<string, unknown> = {
    setupDone: true,
    provider: providerRadios().find((r) => r.checked)?.value ?? 'claude-code',
  };
  for (const [k, el] of Object.entries(form) as [FormKey, HTMLInputElement | HTMLSelectElement][]) {
    next[k] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked
      : el instanceof HTMLInputElement && el.type === 'range' ? +el.value
      : el.value.trim();
  }
  const sttChanged = next.sttModel !== settings.sttModel;
  try {
    settings = await bridge.setSettings(next as Partial<Settings>);
  } catch (e) {
    console.error('could not save settings', e);
    const btn = $('saveSettings');
    btn.textContent = 'Could not save';
    setTimeout(() => { btn.textContent = 'Save'; }, 2500);
    return;
  }
  voice?.setVolumes(settings.voiceVolume, settings.ambienceVolume);
  closeSettings();
  if (sttChanged) preloadEars();
});

boot().catch((e) => {
  console.error(e);
  ui.bootDetail.textContent = `failed: ${e?.message ?? e}`;
});
