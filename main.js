// User — Electron main process.
const { app, BrowserWindow, ipcMain, protocol, net, session, shell, systemPreferences, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const settingsStore = require('./lib/settings');
const { Brain } = require('./lib/ai');

const ROOT = __dirname;

// A privileged custom scheme so ES modules, workers, WASM and fetch() all work
// exactly like on a normal website (file:// is too restricted for that).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win = null;
let settings = null;
const brain = new Brain(() => settings, () => win);

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: '#000005',
    title: 'User',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://local/src/index.html');

  // Links never navigate the companion window; they go to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  settings = settingsStore.load();

  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Microphone for push-to-talk.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'microphone', 'audioCapture'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'microphone', 'audioCapture'].includes(permission));
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* ignore */ }
  }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  brain.cancel();
  if (process.platform !== 'darwin') app.quit();
});

// ------------------------------------------------------------------ IPC
ipcMain.handle('settings:get', () => ({ ...settings, platform: process.platform }));
ipcMain.handle('settings:set', (_e, next) => {
  const providerChanged = next.provider && next.provider !== settings.provider;
  settings = settingsStore.save({ ...settings, ...next });
  if (providerChanged) brain.reset();
  return { ...settings, platform: process.platform };
});

ipcMain.handle('ai:ask', async (e, text) => {
  const emit = (ev) => { if (!e.sender.isDestroyed()) e.sender.send('ai:event', ev); };
  try {
    const reply = await brain.ask(String(text || '').slice(0, 8000), emit);
    return { ok: true, text: reply };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('ai:cancel', () => { brain.cancel(); return true; });
ipcMain.handle('ai:reset', () => { brain.reset(); return true; });

ipcMain.handle('openrouter:models', async () => {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const d = await r.json();
    return (d.data || []).map((m) => m.id).sort();
  } catch { return []; }
});
