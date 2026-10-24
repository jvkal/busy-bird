'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bird', {
  ready: () => ipcRenderer.send('bird:ready'),
  hover: (interactive) => ipcRenderer.send('bird:hover', interactive),
  dragStart: () => ipcRenderer.send('bird:drag-start'),
  dragEnd: () => ipcRenderer.send('bird:drag-end'),
  periodNext: () => ipcRenderer.send('bird:period-next'),
  onTrace: (callback) => ipcRenderer.on('bird:trace', (_event, data) => callback(data)),
  onConnection: (callback) => ipcRenderer.on('bird:connection', (_event, data) => callback(data)),
  onUsage: (callback) => ipcRenderer.on('bird:usage', (_event, data) => callback(data)),
  onSettings: (callback) => ipcRenderer.on('bird:settings', (_event, data) => callback(data)),
});
