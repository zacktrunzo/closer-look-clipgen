const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipgen', {
  // Settings
  getSettings:    () => ipcRenderer.invoke('get-settings'),
  setSettings:    (s) => ipcRenderer.invoke('set-settings', s),
  chooseOutputDir: () => ipcRenderer.invoke('choose-output-dir'),
  chooseBgImage:   () => ipcRenderer.invoke('choose-bg-image'),
  openFolder:     (p) => ipcRenderer.invoke('open-folder', p),

  // Pipeline
  processVideo: (filePath) => ipcRenderer.invoke('process-video', filePath),

  // File drop via will-navigate interception
  onFileDropped: (cb) => {
    const handler = (_, filePath) => cb(filePath);
    ipcRenderer.on('file-dropped', handler);
    return () => ipcRenderer.removeListener('file-dropped', handler);
  },

  // Pipeline event listeners
  onStep: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('pipeline:step', handler);
    return () => ipcRenderer.removeListener('pipeline:step', handler);
  },
  onProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('pipeline:progress', handler);
    return () => ipcRenderer.removeListener('pipeline:progress', handler);
  },

  // Helios readiness check (for Settings UI indicator)
  checkHelios: () => ipcRenderer.invoke('check-helios'),

  // Auto-updater
  onUpdateStatus: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  onUpdateProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // Platform info
  platform: process.platform,
});
