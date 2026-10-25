'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// Brand icons shipped with the widget (from busy-magpie, MIT licensed).
let brandIcons = {};
try {
  const brandDir = path.join(__dirname, '..', 'assets', 'brands');
  brandIcons = Object.fromEntries(fs.readdirSync(brandDir)
    .filter(name => name.endsWith('.svg'))
    .map(name => [name.slice(0, -4), fs.readFileSync(path.join(brandDir, name), 'utf8').trim()]));
} catch {
  brandIcons = {};
}

contextBridge.exposeInMainWorld('bird', {
  brandIcons,
  ready: () => ipcRenderer.send('bird:ready'),
  hitAreas: (areas) => ipcRenderer.send('bird:hit-areas', areas),
  dragStart: () => ipcRenderer.send('bird:drag-start'),
  dragEnd: () => ipcRenderer.send('bird:drag-end'),
  resizeStart: (dir) => ipcRenderer.send('bird:resize-start', dir),
  resizeEnd: () => ipcRenderer.send('bird:resize-end'),
  press: (down) => ipcRenderer.send('bird:press', down),
  panel: (open) => ipcRenderer.send('bird:panel', open),
  saveSettings: (patch) => ipcRenderer.send('bird:save-settings', patch),
  resetPlace: () => ipcRenderer.send('window:reset'),
  stats: () => ipcRenderer.send('bird:stats'),
  onStats: (callback) => ipcRenderer.on('bird:stats', (_event, data) => callback(data)),
  periodNext: () => ipcRenderer.send('bird:period-next'),
  onTrace: (callback) => ipcRenderer.on('bird:trace', (_event, data) => callback(data)),
  onConnection: (callback) => ipcRenderer.on('bird:connection', (_event, data) => callback(data)),
  onUsage: (callback) => ipcRenderer.on('bird:usage', (_event, data) => callback(data)),
  onSettings: (callback) => ipcRenderer.on('bird:settings', (_event, data) => callback(data)),
  onSnap: (callback) => ipcRenderer.on('bird:snap', (_event, data) => callback(data)),
  onExpand: (callback) => ipcRenderer.on('bird:expand', (_event, data) => callback(data)),
});
