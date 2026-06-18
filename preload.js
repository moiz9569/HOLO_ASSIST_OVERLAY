const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('holoAPI', {
  // Audio Sources
  getAudioSources: () => ipcRenderer.invoke('get-audio-sources'),

  // Panel & Bubble Controls
  togglePanel: () => ipcRenderer.send('toggle-panel'),
  hideBubble: () => ipcRenderer.send('hide-bubble'),
  dragBubble: (delta) => ipcRenderer.send('drag-bubble', delta),

  // Window Controls
  minimizeOverlay: () => ipcRenderer.send('minimize-overlay'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  closeOverlay: () => ipcRenderer.send('close-overlay'),
  resizeOverlay: (size) => ipcRenderer.send('resize-overlay', size),

  // Window Management
  setAlwaysOnTop: (val) =>
    ipcRenderer.send('set-always-on-top', val),

  dragWindow: (delta) =>
    ipcRenderer.send('drag-window', delta),

  // App Controls
  quitApp: () => ipcRenderer.send('quit-app'),

  // Mac BlackHole Support
  installBlackHole: () =>
    ipcRenderer.invoke('install-blackhole'),

  recheckBlackHole: () =>
    ipcRenderer.invoke('recheck-blackhole'),

  onMacNeedsBlackHole: (cb) =>
    ipcRenderer.on('mac-needs-blackhole', cb),

  // Meeting Detection Events
  onMeetingState: (cb) =>
    ipcRenderer.on('meeting-state', (_e, active) => cb(active)),

  // Platform Information
  platform: process.platform, // 'win32' | 'darwin' | 'linux'
});
