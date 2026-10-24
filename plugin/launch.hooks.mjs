// Busy Bird launcher plugin.
//
// magpie loads this file in its Bun plugin host the first time the plugin is
// used. It starts the desktop widget if it can find one — an installed copy,
// an executable named by BUSY_BIRD_APP, or the electron checkout inside this
// package — and then stays quiet. The gateway request is always passed
// through untouched.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, '..');
const ALIVE_MS = 30000;

let launched = false;
let lastEnsure = 0;
let warned = false;

function supportDir() {
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(roaming, 'Busy Bird');
  }
  return path.join(homedir(), 'Library', 'Application Support', 'Busy Bird');
}

// The card touches this file while it runs, so a request can tell a hidden
// window from an exited process: hidden still writes, exited goes stale.
function appState() {
  const file = path.join(supportDir(), 'alive');
  try {
    const stat = statSync(file);
    return Date.now() - stat.mtimeMs < ALIVE_MS ? 'alive' : 'dead';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'unknown' : 'dead';
  }
}

// The user asked the widget to quit: it leaves this marker behind and the
// launcher stops calling it back until the widget itself starts again.
function stopped() {
  try {
    return existsSync(path.join(supportDir(), 'stopped'));
  } catch {
    return false;
  }
}

function electronExecutable(dir) {
  const dist = path.join(dir, 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') {
    const exe = path.join(dist, 'electron.exe');
    return existsSync(exe) ? { exe, cwd: dir, args: ['.'] } : null;
  }
  if (process.platform === 'darwin') {
    for (const name of readdirSync(dist)) {
      if (name.endsWith('.app')) {
        return { exe: path.join(dist, name, 'Contents', 'MacOS', 'Electron'), cwd: dir, args: ['.'] };
      }
    }
  }
  const bin = path.join(dist, 'electron');
  return existsSync(bin) ? { exe: bin, cwd: dir, args: ['.'] } : null;
}

function candidates() {
  const out = [];
  const custom = process.env.BUSY_BIRD_APP;
  if (custom) out.push({ exe: custom, cwd: path.dirname(custom), args: [] });
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) out.push({ exe: path.join(local, 'Programs', 'Busy Bird', 'Busy Bird.exe'), cwd: '', args: [] });
  } else if (process.platform === 'darwin') {
    out.push({ exe: '/Applications/Busy Bird.app/Contents/MacOS/Busy Bird', cwd: '', args: [] });
    out.push({ exe: path.join(homedir(), 'Applications', 'Busy Bird.app', 'Contents', 'MacOS', 'Busy Bird'), cwd: '', args: [] });
  }
  const dev = electronExecutable(PKG_DIR);
  if (dev) out.push(dev);
  return out;
}

function spawnApp(target) {
  try {
    // Electron switches to a headless Node mode when ELECTRON_RUN_AS_NODE
    // leaks in from a terminal that launched magpie.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(target.exe, target.args, {
      cwd: target.cwd || PKG_DIR,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (error) => {
      launched = false;
      console.warn(`[busy-bird] could not start ${target.exe}: ${error.message}`);
    });
    child.unref();
    child.once('spawn', () => {
      launched = true;
      console.log(`[busy-bird] started ${target.exe}`);
    });
  } catch (error) {
    console.warn(`[busy-bird] could not start ${target.exe}: ${error.message}`);
  }
}

function ensureApp() {
  if (process.env.BUSY_BIRD_NO_LAUNCH === '1') return;
  const state = appState();
  if (state === 'alive') {
    launched = true;
    return;
  }
  if (state === 'unknown' && launched) return;
  if (stopped()) return;
  const now = Date.now();
  if (now - lastEnsure < 60000) return;
  lastEnsure = now;
  launched = false;

  for (const target of candidates()) {
    try {
      if (target.exe && existsSync(target.exe)) {
        spawnApp(target);
        return;
      }
    } catch {
      // A malformed override simply does not match.
    }
  }
  if (!warned) {
    warned = true;
    console.warn('[busy-bird] app not found; run `npm install && npm start` in the busy-bird '
      + 'checkout, install the packaged app, or set BUSY_BIRD_APP to its executable');
  }
}

// Start as soon as the hook module is loaded; onRequest remains a fallback
// for hosts that import this file before spawning their first request.
ensureApp();

export function onRequest(body) {
  ensureApp();
  return body;
}
