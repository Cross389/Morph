'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('morphShell', {
  call: (method, args, channel) => ipcRenderer.invoke('morph:call', { method, args: args || {}, channel: channel || 'shell' }),
  onEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('morph:event', handler);
    return () => ipcRenderer.removeListener('morph:event', handler);
  },
});
