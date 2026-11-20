const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('userBridge', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  ask: (text) => ipcRenderer.invoke('ai:ask', text),
  cancel: () => ipcRenderer.invoke('ai:cancel'),
  reset: () => ipcRenderer.invoke('ai:reset'),
  listModels: () => ipcRenderer.invoke('openrouter:models'),
  onEvent: (fn) => {
    const h = (_e, ev) => fn(ev);
    ipcRenderer.on('ai:event', h);
    return () => ipcRenderer.removeListener('ai:event', h);
  },
});
