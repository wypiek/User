// Persistent settings stored in the app's userData folder.
// The OpenRouter key is encrypted with the OS keychain (safeStorage) when available.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  provider: 'claude-code', // 'claude-code' | 'openrouter'
  openrouterModel: 'anthropic/claude-sonnet-5.5',
  claudePath: 'claude',
  claudeModel: '', // empty = Claude Code's default
  deviceControl: true, // let User open apps / control the device
  confirmCommands: true, // ask before User runs shell commands (OpenRouter mode)
  sttModel: 'onnx-community/whisper-base.en',
  voiceVolume: 0.9,
  ambienceVolume: 0.35,
  setupDone: false,
};

const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
  const s = { ...DEFAULTS, ...raw };
  s.openrouterKey = '';
  if (raw.openrouterKeyEnc) {
    try {
      s.openrouterKey = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(raw.openrouterKeyEnc, 'base64'))
        : Buffer.from(raw.openrouterKeyEnc, 'base64').toString('utf8');
    } catch { s.openrouterKey = ''; }
  }
  delete s.openrouterKeyEnc;
  return s;
}

function save(next) {
  const { openrouterKey, ...rest } = next;
  const out = { ...rest };
  if (openrouterKey) {
    out.openrouterKeyEnc = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(openrouterKey).toString('base64')
      : Buffer.from(openrouterKey, 'utf8').toString('base64');
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(out, null, 2));
  return load();
}

module.exports = { load, save, DEFAULTS };
