// User — renderer: wires the world, the character, his voice, his ears and his brain.
import { World } from './scene.js';
import { loadCharacter } from './character.js';
import { Voice } from './voice.js';
import { MicRecorder, loadSTT, transcribe } from './stt.js';

const $ = (id) => document.getElementById(id);
const bridge = window.userBridge;

const ui = {
  caption: $('caption'), status: $('status'), heard: $('heard'), doing: $('doing'),
  typebox: $('typebox'), settings: $('settings'), boot: $('boot'), bootDetail: $('boot-detail'),
  clock: $('clock'), counter: $('counter'),
};

let settings = null;
let world, user, voice;
const mic = new MicRecorder();
let mode = 'booting'; // booting | summon | idle | listening | transcribing | thinking | doing | responding | waiting
let idleTimer = null;
let captionTimer = null;
let sttReady = false;
let sttError = null;
let ptt = { down: false, combo: false };

// ------------------------------------------------------------------ boot
async function boot() {
  settings = await bridge.getSettings();
  const canvas = $('stage');
  world = new World(canvas);
  voice = new Voice('/assets/sounds/');
  voice.setVolumes(settings.voiceVolume, settings.ambienceVolume);

  ui.bootDetail.textContent = 'loading glass houses';
  const [ , character] = await Promise.all([
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
  sttReady = false; sttError = null;
  const files = {};
  loadSTT(settings.sttModel, (p) => {
    if (p.status === 'progress' && p.file) {
      files[p.file] = p.progress || 0;
      const vals = Object.values(files);
      const pct = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      if (mode === 'idle' || mode === 'waiting') setStatus(`he is learning to hear you... ${pct}%`);
    }
  }).then(() => { sttReady = true; if (mode === 'idle' || mode === 'waiting') readyStatus(); })
    .catch((e) => {
      sttError = e; console.error('speech model failed', e);
      if (mode === 'idle' || mode === 'waiting') setStatus('he cannot hear you (speech model failed to load) — press ENTER to type');
    });
}

function readyStatus() {
  if (sttError) return setStatus('he cannot hear you — press ENTER to type');
  setStatus(sttReady ? 'hold [LEFT CTRL] to speak · ENTER to type' : 'hold [LEFT CTRL] to speak (his ears are still loading)');
}

function setStatus(text, cls = '') {
  ui.status.textContent = text;
  ui.status.className = cls;
}

// ------------------------------------------------------------------ loop
function startLoop() {
  const t0 = performance.now();
  let last = t0;
  let acc = 0;
  const FRAME = 1 / 24; // it's a tape. 24 fps.
  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    user.update(dt);
    // glitch intensity follows his state
    const target = { summon: 0.6, doing: 0.35, thinking: 0.12, listening: 0.05, transcribing: 0.1 }[mode] ?? 0.02;
    world.glitch += (target - world.glitch) * Math.min(1, dt * 2);
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
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  const pad = (n) => String(n).padStart(2, '0');
  ui.clock.textContent = `${ap} ${h}:${pad(d.getMinutes())}:${pad(d.getSeconds())}  ${mon}. ${pad(d.getDate())} 2006`;
  const s = Math.floor((Date.now() - started) / 1000);
  ui.counter.textContent = `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

// ------------------------------------------------------------------ states
function setMode(m) {
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
      idleTimer = setTimeout(() => setMode('idle'), 15000);
      break;
    case 'idle': user.setState('idle'); readyStatus(); break;
  }
}

const busy = () => ['thinking', 'doing', 'transcribing', 'summon', 'booting'].includes(mode);

// ------------------------------------------------------------------ talking to him
async function handleUserText(text) {
  text = text.trim();
  if (!text) return setMode('waiting');
  ui.heard.textContent = `you: ${text}`;
  ui.doing.textContent = '';
  setMode('thinking');
  const res = await bridge.ask(text);
  ui.doing.textContent = '';
  if (mode !== 'thinking' && mode !== 'doing') return; // cancelled
  if (!res.ok) return say(`...something is wrong. ${res.error}`, { error: true });
  return say(cleanReply(res.text));
}

bridge.onEvent((ev) => {
  if (ev.type === 'doing' && (mode === 'thinking' || mode === 'doing')) {
    ui.doing.textContent = ev.label;
    setMode('doing');
  }
});

function cleanReply(t) {
  return String(t)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|\*|#+\s/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim() || '...';
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function say(text, { error = false } = {}) {
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
  captionTimer = setTimeout(() => ui.caption.classList.add('fade'), Math.max(7000, words * 450));
  setMode('waiting');
}

// ------------------------------------------------------------------ push to talk: LEFT CONTROL
async function startListening() {
  if (busy()) { flashStatus(mode === 'summon' ? '...' : 'he is busy. ESC to stop him.'); return; }
  voice.stop();
  ptt = { down: true, combo: false };
  setMode('listening');
  try {
    await mic.start();
    if (!ptt.down) { mic.cancel(); setMode('waiting'); } // released before the mic opened
  } catch (e) {
    ptt.down = false;
    setMode('waiting');
    flashStatus('no microphone: ' + (e.message || e.name));
  }
}

async function finishListening() {
  if (!ptt.down) return;
  ptt.down = false;
  if (ptt.combo) { mic.cancel(); setMode('waiting'); return; }
  if (!mic.recording) return;
  setMode('transcribing');
  if (!sttReady && !sttError) setStatus('his ears are still loading...');
  try {
    const pcm = await mic.stop();
    const text = await transcribe(pcm, settings.sttModel);
    if (!text) { setMode('waiting'); flashStatus('...he didn\'t hear anything.'); return; }
    await handleUserText(text);
  } catch (e) {
    console.error(e);
    setMode('waiting');
    flashStatus('he could not understand: ' + (e.message || e));
  }
}

let flashTimer = null;
function flashStatus(text) {
  setStatus(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (mode === 'idle' || mode === 'waiting') readyStatus(); }, 3500);
}

function stopHim() {
  if (mode === 'responding') { voice.stop(); setMode('waiting'); }
  else if (mode === 'thinking' || mode === 'doing') { bridge.cancel(); ui.doing.textContent = ''; say('...fine.'); }
}

window.addEventListener('keydown', (e) => {
  voice?.resume();
  if (!ui.settings.hidden) { if (e.key === 'Escape') closeSettings(); return; }
  if (e.key === 'F1') { e.preventDefault(); openSettings(); return; }
  const typing = document.activeElement === ui.typebox;
  if (e.code === 'ControlLeft') {
    if (!e.repeat && !typing && !ptt.down) startListening();
    return;
  }
  if (ptt.down) { ptt.combo = true; return; } // Ctrl+<key> shortcut, not push-to-talk
  if (typing) {
    if (e.key === 'Enter') {
      const v = ui.typebox.value; ui.typebox.value = ''; closeTypebox();
      if (!busy() && v.trim()) { voice.stop(); handleUserText(v); }
    } else if (e.key === 'Escape') closeTypebox();
    return;
  }
  if (e.key === 'Enter' && mode !== 'summon' && mode !== 'booting') { e.preventDefault(); openTypebox(); }
  else if (e.key === 'Escape') stopHim();
});
window.addEventListener('keyup', (e) => { if (e.code === 'ControlLeft') finishListening(); });
window.addEventListener('blur', () => { if (ptt.down) finishListening(); });

function openTypebox() { ui.typebox.classList.add('open'); ui.typebox.focus(); }
function closeTypebox() { ui.typebox.classList.remove('open'); ui.typebox.blur(); }

// ------------------------------------------------------------------ settings
const form = {
  claudePath: $('claudePath'), claudeModel: $('claudeModel'), openrouterKey: $('openrouterKey'),
  openrouterModel: $('openrouterModel'), deviceControl: $('deviceControl'), confirmCommands: $('confirmCommands'),
  voiceVolume: $('voiceVolume'), ambienceVolume: $('ambienceVolume'), sttModel: $('sttModel'),
};

function syncProviderFieldsets() {
  const p = document.querySelector('input[name=provider]:checked')?.value;
  document.querySelectorAll('#settings fieldset[data-for]').forEach((f) => f.classList.toggle('off', f.dataset.for !== p));
}

let modelsLoaded = false;
function openSettings() {
  for (const [k, el] of Object.entries(form)) {
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else el.value = settings[k] ?? '';
  }
  document.querySelectorAll('input[name=provider]').forEach((r) => { r.checked = r.value === settings.provider; });
  syncProviderFieldsets();
  ui.settings.hidden = false;
  if (!modelsLoaded) {
    modelsLoaded = true;
    bridge.listModels().then((ids) => { $('models').innerHTML = ids.map((id) => `<option value="${escapeHtml(id)}">`).join(''); });
  }
}
function closeSettings() { ui.settings.hidden = true; }

document.querySelectorAll('input[name=provider]').forEach((r) => r.addEventListener('change', syncProviderFieldsets));
form.voiceVolume.addEventListener('input', () => voice.setVolumes(+form.voiceVolume.value, +form.ambienceVolume.value));
form.ambienceVolume.addEventListener('input', () => voice.setVolumes(+form.voiceVolume.value, +form.ambienceVolume.value));
$('gear').addEventListener('click', openSettings);
$('cancelSettings').addEventListener('click', () => { voice.setVolumes(settings.voiceVolume, settings.ambienceVolume); closeSettings(); });
$('forget').addEventListener('click', async () => { await bridge.reset(); ui.heard.textContent = ''; ui.caption.innerHTML = ''; closeSettings(); flashStatus('he forgot everything.'); });
$('saveSettings').addEventListener('click', async () => {
  const next = { setupDone: true, provider: document.querySelector('input[name=provider]:checked')?.value || 'claude-code' };
  for (const [k, el] of Object.entries(form)) {
    next[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value.trim();
  }
  const sttChanged = next.sttModel !== settings.sttModel;
  settings = await bridge.setSettings(next);
  voice.setVolumes(settings.voiceVolume, settings.ambienceVolume);
  closeSettings();
  if (sttChanged) preloadEars();
  if (settings.provider === 'openrouter' && !settings.openrouterKey) flashStatus('he needs an openrouter key (F1)');
});

boot().catch((e) => {
  console.error(e);
  ui.bootDetail.textContent = 'failed: ' + (e.message || e);
});
