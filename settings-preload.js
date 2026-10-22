const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('settingsAPI', {
  call: (action, payload) => ipcRenderer.invoke('settings', action, payload),
});
