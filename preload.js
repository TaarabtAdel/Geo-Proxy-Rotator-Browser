const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('browserAPI', {
  command: (action, payload, tabId) => ipcRenderer.invoke('command', action, payload, tabId),
  onTabs: (fn) => ipcRenderer.on('tabs', (_, data) => fn(data)),
  onRunnerPanel: (fn) => ipcRenderer.on('runner-panel', (_, data) => fn(data)),
  onFocusAddress: (fn) => ipcRenderer.on('focus-address', () => fn()),
});
