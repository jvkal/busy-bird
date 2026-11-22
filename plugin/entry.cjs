'use strict';

// Magpie loads a plugin package in its Bun host; Electron loads the same
// package when it starts the desktop widget. Keep the Electron main process
// out of Magpie's module graph so require('electron') is never resolved there.
if (process.versions.electron && process.type === 'browser') {
  require('../src/main.js');
} else {
  module.exports = {};
}
