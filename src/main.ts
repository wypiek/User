// User — frontend: wires the world, the character, his voice, his ears and his brain (Rust).
import { World } from './scene';
import { loadCharacter, type Character } from './character';
import { Voice } from './voice';
import { loadSTT, transcribe } from './stt';
import { bridge, type Settings } from './bridge';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  caption: $('caption'), status: $('status'), heard: $('heard'), doing: $('doing'),
  typebox: $<HTMLInputElement>('typebox'), settings: $('settings'), boot: $('boot'), bootDetail: $('boot-detail'),
  clock: $('clock'), counter: $('counter'),
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
let ptt = { down: false, combo: false, recording: false };

// ------------------------------------------------------------------ boot
async function boot() {
  settings = await bridge.getSettings();
  world = new World($<HTMLCanvasElement>('stage'));
  voice = new Voice('/assets/sounds/');
  voice.setVolumes(settings.voiceVolume, settings.ambienceVolume);

  ui.bootDetail.textContent = 'loading glass houses';
  const [, character] = await Promise.all([
    world.loadMap('/assets/models/map/', 'glasshousesmap.mtl', 'glasshousesmap.obj', (e) => {
      if (e.lengthComputable) ui.bootDetail.textContent = `loading glass houses ${Math.round((e.loaded / e.total) * 100)}%`;
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
  setStatus('');
  user.setState('summon', { force: true });
  world.glitch = 1;
  voice.startAmbience();
  voice.play('glass', { rate: 0.8, gain: 0.8 });
  setTimeout(() => voice.play('press', { rate: 0.6, gain: 0.7 }), 1900);
}

function afterSummon() {
  mode = 'idle';
  user.setState('idle');
  readyStatus();
  preloadEars();
  if (!settings.setupDone) setTimeout(openSettings, 600);
}

function preloadEars() {
  sttReady = false;
  sttError = null;
  const files: Record<string, number> = {};
  loadSTT(settings.sttModel, (p) => {
    if (p.status === 'progress' && p.file) {
      files[p.file] = p.progress ?? 0;
      const vals = Object.values(files);
      const pct = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      if (mode === 'idle' || mode === 'waiting') setStatus(`he is learning to hear you... ${pct}%`);
    }
  })
    .then(() => { sttReady = true; if (mode === 'idle' || mode === 'waiting') readyStatus(); })
    .catch((e) => {
      sttError = e;
      console.error('speech model failed', e);
      if (mode === 'idle' || mode === 'waiting') readyStatus();
    });
}

function readyStatus() {
  if (sttError) return setStatus('he cannot hear you (speech model failed to load) · ENTER to type');
  setStatus(sttReady ? 'hold [LEFT CTRL] to speak · ENTER to type' : 'hold [LEFT CTRL] to speak (his ears are still loading)');
}

function setStatus(text: string, cls = '') {
  ui.status.textContent = text;
  ui.status.className = cls;
}

// ------------------------------------------------------------------ loop
function startLoop() {
  const t0 = performance.now();
  let last = t0;
  let acc = 0;
  const FRAME = 1 / 24; // it's a tape. 24 fps.
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    user.update(dt);
    // glitch intensity follows his state
    const targets: Partial<Record<Mode, number>> = { summon: 0.6, doing: 0.35, thinking: 0.12, listening: 0.05, transcribing: 0.1 };
    world.glitch += ((targets[mode] ?? 0.02) - world.glitch) * Math.min(1, dt * 2);
    if (Math.random() < 0.002) world.glitch = 0.9; // the tape catches
    if (acc < FRAME) return;
    acc %= FRAME;
    world.render((now - t0) / 1000);
  };
  requestAnimationFrame(frame);
  setInterval(updateOSD, 250);
  updateOSD();
}

const started = Date.now();
function updateOSD() {
  const d = new Date();
  const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const pad = (n: number) => String(n).padStart(2, '0');
  ui.clock.textContent = `${ap} ${h}:${pad(d.getMinutes())}:${pad(d.getSeconds())}  ${mon}. ${pad(d.getDate())} 2006`;
  const s = Math.floor((Date.now() - started) / 1000);
  ui.counter.textContent = `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

// ------------------------------------------------------------------ states
function setMode(m: Mode) {
  mode = m;
  clearTimeout(idleTimer);
  user.ctx.listening = m === 'listening';
  switch (m) {
    case 'listening': user.setState('waiting', { force: true }); setStatus('listening... (release LEFT CTRL)', 'listening'); break;
    case 'transcribing': user.setState('waiting'); setStatus('...'); break;
    case 'thinking': user.setState('thinking'); setStatus('User is thinking'); break;
    case 'doing': user.setState('doing'); setStatus('User is doing something'); break;
    case 'responding': user.setState('responding'); setStatus(''); break;
    case 'waiting':
      user.setState('waiting', { force: true });
      readyStatus();
      idleTimer = window.setTimeout(() => setMode('idle'), 15000);
      break;
    case 'idle': user.setState('idle'); readyStatus(); break;
    default: break;
  }
}

const busy = () => (['thinking', 'doing', 'transcribing', 'summon', 'booting'] as Mode[]).includes(mode);

// ------------------------------------------------------------------ talking to him
async function handleUserText(raw: string) {
  const text = raw.trim();
  if (!text) return setMode('waiting');
  ui.heard.textContent = `you: ${text}`;
  ui.doing.textContent = '';
  setMode('thinking');
  const res = await bridge.ask(text, (ev) => {
    if (ev.type === 'doing' && (mode === 'thinking' || mode === 'doing')) {
      ui.doing.textContent = ev.label;
      setMode('doing');
    }
  });
  ui.doing.textContent = '';
  if (mode !== 'thinking' && mode !== 'doing') return; // cancelled
  if (!res.ok) return say(`...something is wrong. ${res.error}`, { error: true });
  return say(cleanReply(res.text));
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

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function say(text: string, { error = false } = {}) {
  setMode('responding');
  clearTimeout(captionTimer);
  ui.caption.className = 'flicker' + (error ? ' error' : '');
  ui.caption.innerHTML = '';
  let shown = '';
  await voice.speak(text, {
    onChunk: (soFar) => {
      const fresh = soFar.slice(shown.length);
      ui.caption.innerHTML = escapeHtml(shown) + `<span class="new">${escapeHtml(fresh)}</span>`;
      shown = soFar;
    },
    onSyllable: () => user.syllable(),
  });
  if (mode !== 'responding') return;
  ui.caption.classList.remove('flicker');
  const words = text.split(/\s+/).length;
  captionTimer = window.setTimeout(() => ui.caption.classList.add('fade'), Math.max(7000, words * 450));
  setMode('waiting');
}

// ------------------------------------------------------------------ push to talk: LEFT CONTROL
async function startListening() {
  if (busy()) { flashStatus(mode === 'summon' ? '...' : 'he is busy. ESC to stop him.'); return; }
  voice.stop();
  ptt = { down: true, combo: false, recording: false };
  setMode('listening');
  try {
    await bridge.micStart(); // captured natively in Rust
    ptt.recording = true;
    if (!ptt.down) { await bridge.micCancel(); ptt.recording = false; setMode('waiting'); } // released before the mic opened
  } catch (e) {
    ptt.down = false;
    setMode('waiting');
    flashStatus(`no microphone: ${e}`);
  }
}

async function finishListening() {
  if (!ptt.down) return;
  ptt.down = false;
  if (!ptt.recording) return; // startListening will clean up
  ptt.recording = false;
  if (ptt.combo) { await bridge.micCancel(); setMode('waiting'); return; }
  setMode('transcribing');
  if (!sttReady && !sttError) setStatus('his ears are still loading...');
  try {
    const pcm = await bridge.micStop();
    const text = await transcribe(pcm, settings.sttModel);
    if (!text) { setMode('waiting'); flashStatus("...he didn't hear anything."); return; }
    await handleUserText(text);
  } catch (e) {
    console.error(e);
    setMode('waiting');
    flashStatus(`he could not understand: ${e}`);
  }
}

let flashTimer: number | undefined;
function flashStatus(text: string) {
  setStatus(text);
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => { if (mode === 'idle' || mode === 'waiting') readyStatus(); }, 3500);
}

function stopHim() {
  if (mode === 'responding') { voice.stop(); setMode('waiting'); }
  else if (mode === 'thinking' || mode === 'doing') { void bridge.cancel(); ui.doing.textContent = ''; void say('...fine.'); }
}

window.addEventListener('keydown', (e) => {
  voice?.resume();
  if (!ui.settings.hidden) { if (e.key === 'Escape') closeSettings(); return; }
  if (e.key === 'F1') { e.preventDefault(); openSettings(); return; }
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
  document.querySelectorAll<HTMLElement>('#settings fieldset[data-for]').forEach((f) => f.classList.toggle('off', f.dataset.for !== p));
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
  if (!modelsLoaded) {
    modelsLoaded = true;
    void bridge.listModels().then((ids) => { $('models').innerHTML = ids.map((id) => `<option value="${escapeHtml(id)}">`).join(''); });
  }
}
function closeSettings() { ui.settings.hidden = true; }

providerRadios().forEach((r) => r.addEventListener('change', syncProviderFieldsets));
const previewVolumes = () => voice?.setVolumes(+form.voiceVolume.value, +form.ambienceVolume.value);
form.voiceVolume.addEventListener('input', previewVolumes);
form.ambienceVolume.addEventListener('input', previewVolumes);
$('gear').addEventListener('click', openSettings);
$('cancelSettings').addEventListener('click', () => { voice?.setVolumes(settings.voiceVolume, settings.ambienceVolume); closeSettings(); });
$('forget').addEventListener('click', async () => {
  await bridge.reset();
  ui.heard.textContent = '';
  ui.caption.innerHTML = '';
  closeSettings();
  flashStatus('he forgot everything.');
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
    flashStatus(`could not save settings: ${e}`);
    return;
  }
  voice?.setVolumes(settings.voiceVolume, settings.ambienceVolume);
  closeSettings();
  if (sttChanged) preloadEars();
  if (settings.provider === 'openrouter' && !settings.openrouterKey) flashStatus('he needs an openrouter key (F1)');
});

boot().catch((e) => {
  console.error(e);
  ui.bootDetail.textContent = `failed: ${e?.message ?? e}`;
});
