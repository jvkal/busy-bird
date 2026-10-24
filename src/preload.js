'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bird', {
  ready: () => ipcRenderer.send('bird:ready'),
  hitAreas: (areas) => ipcRenderer.send('bird:hit-areas', areas),
  dragStart: () => ipcRenderer.send('bird:drag-start'),
  dragEnd: () => ipcRenderer.send('bird:drag-end'),
  resizeStart: (direction) => ipcRenderer.send('bird:resize-start', direction),
  resizeEnd: () => ipcRenderer.send('bird:resize-end'),
  panel: (open) => ipcRenderer.send('bird:panel', open),
  saveSettings: (patch) => ipcRenderer.send('bird:save-settings', patch),
  resetPlace: () => ipcRenderer.send('window:reset'),
  periodNext: () => ipcRenderer.send('bird:period-next'),
  onTrace: (callback) => ipcRenderer.on('bird:trace', (_event, data) => callback(data)),
  onConnection: (callback) => ipcRenderer.on('bird:connection', (_event, data) => callback(data)),
  onUsage: (callback) => ipcRenderer.on('bird:usage', (_event, data) => callback(data)),
  onSettings: (callback) => ipcRenderer.on('bird:settings', (_event, data) => callback(data)),
  onSnap: (callback) => ipcRenderer.on('bird:snap', (_event, data) => callback(data)),
});
