'use strict';

// Busy Bird — a tiny transparent perch where a bird carries every magpie
// request. The main process owns the window, reads magpie's local trace and
// usage, and forwards both to the renderer over IPC.

const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIDTH = 260;
const HEIGHT = 160;
const TOPBAR_H = 26;
const MIN_WIDTH = 220;
// The stage keeps its shape: height follows width, so the SVG canvas scales
// instead of leaving bands.
const RATIO = WIDTH / (HEIGHT - TOPBAR_H);
const heightForWidth = (width) => Math.round(width / RATIO) + TOPBAR_H;
const widthForHeight = (height) => Math.round((height - TOPBAR_H) * RATIO);
const UPDATE_MS = 60 * 1000;

const IS_SHOT = process.argv.find((arg) => arg.startsWith('--shot='));
const IS_DEMO = process.argv.includes('--demo') || Boolean(IS_SHOT);

let win = null;
let tray = null;
let quitting = false;
let settings = null;
let settingsPath = null;
let trace = null;
let connection = { online: false, detail: '正在连接' };
let usageData = null;
let client = null;
let usageTimer = null;
let aliveTimer = null;
let shotTimer = null;

// ── settings ────────────────────────────────────────────────────────────────

function defaultSettings() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    topmost: true,
    left: area.x + Math.round((area.width - WIDTH) / 2),
    top: area.y + Math.round((area.height - HEIGHT) / 2),
    width: WIDTH,
    height: HEIGHT,
    gateway: null,
    usagePeriod: 'today',
    opacity: 0.34,
    themeColor: null,
  };
}

function loadSettings() {
  settingsPath = path.join(app.getPath('appData'), 'Busy Bird', 'settings.json');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    // First run, or the file does not read: fall back to defaults.
  }
  settings = { ...defaultSettings(), ...stored };
  settings.width = Math.min(Math.max(Number(settings.width) || WIDTH, MIN_WIDTH), 4000);
  settings.height = heightForWidth(settings.width);
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {
    // Losing a settings write must never take the widget down.
  }
}

// ── gateway address ─────────────────────────────────────────────────────────

function parseAddr(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  const match = raw.match(/^([\w.[\]:-]+):(\d+)$/);
  if (!match) return null;
  let host = match[1];
  if (host === '0.0.0.0') host = '127.0.0.1';
  return `http://${host}:${match[2]}`;
}

function resolveGateway() {
  const fromSettings = parseAddr(settings.gateway);
  if (fromSettings) return fromSettings;
  const fromEnv = parseAddr(process.env.BUSY_BIRD_GATEWAY) || parseAddr(process.env.MAGPIE_ADDR);
  if (fromEnv) return fromEnv;
  try {
    const file = path.join(os.homedir(), '.config', 'magpie', 'settings.json');
    const port = JSON.parse(fs.readFileSync(file, 'utf8')).port;
    const fromConfig = parseAddr(`127.0.0.1:${port}`);
    if (fromConfig) return fromConfig;
  } catch {
    // No local magpie config: keep the default port.
  }
  return 'http://127.0.0.1:3425';
}

// ── trace long poll ─────────────────────────────────────────────────────────

const BACKOFF = [1000, 2000, 4000, 5000];

class TraceClient {
  constructor(base) {
    this.base = base;
    this.seq = 0;
    this.first = true;
    this.stopped = false;
    this.controller = null;
    this.pid = 0;
    this.routes = new Map();
  }

  start() {
    this.stopped = false;
    this.loop().catch(() => {});
  }

  stop() {
    this.stopped = true;
    if (this.controller) this.controller.abort();
  }

  async loop() {
    let miss = 0;
    while (!this.stopped) {
      let timeout = null;
      try {
        this.controller = new AbortController();
        timeout = setTimeout(() => this.controller.abort(), 40000);
        const suffix = this.first ? '' : '&wait=1';
        const response = await fetch(`${this.base}/v1/magpie/trace?after=${this.seq}${suffix}`, {
          signal: this.controller.signal,
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`magpie answered ${response.status}`);
        const data = await response.json();
        const pid = Number(data.pid) || 0;
        if ((pid && this.pid && pid !== this.pid) || (this.seq > 0 && Number(data.seq) < this.seq)) {
          this.pid = pid;
          this.seq = 0;
          this.first = true;
          this.routes.clear();
          continue;
        }
        this.pid = pid || this.pid;
        this.seq = Number(data.seq) || 0;
        this.first = false;
        for (const route of Array.isArray(data.routes) ? data.routes : []) {
          this.routes.set(String(route.id), route);
        }
        while (this.routes.size > 120) {
          const done = [...this.routes.values()].filter((route) => route.done)
            .sort((a, b) => new Date(a.time) - new Date(b.time));
          if (!done.length) break;
          this.routes.delete(String(done[0].id));
        }
        trace = { ...data, routes: [...this.routes.values()] };
        connection = { online: true, detail: this.base, at: Date.now() };
        send('bird:trace', trace);
        send('bird:connection', connection);
        miss = 0;
      } catch (error) {
        if (this.stopped) break;
        const detail = error.name === 'AbortError' ? '读取超时' : error.message;
        connection = { online: false, detail };
        send('bird:connection', connection);
        // magpie may come back on another port: resolve again on every retry.
        const base = resolveGateway();
        if (base !== this.base) {
          this.base = base;
          this.seq = 0;
          this.first = true;
        }
        await new Promise((resolve) => setTimeout(resolve, BACKOFF[Math.min(miss++, BACKOFF.length - 1)]));
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

// ── usage ───────────────────────────────────────────────────────────────────

const PERIODS = ['today', '7d', '30d', 'all'];

async function refreshUsage() {
  const period = PERIODS.includes(settings.usagePeriod) ? settings.usagePeriod : 'today';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${client.base}/v1/magpie/usage?period=${period}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    usageData = { ...data, period };
    send('bird:usage', usageData);
  } catch {
    // Keep the last good numbers on the pill; the next tick retries.
  }
}

function startUsageTimer() {
  clearInterval(usageTimer);
  refreshUsage();
  usageTimer = setInterval(refreshUsage, UPDATE_MS);
}

// ── window ──────────────────────────────────────────────────────────────────

function clampBounds(x, y, w = WIDTH, h = HEIGHT) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.min(Math.max(x, area.x - w + 60), area.x + area.width - 60),
    y: Math.min(Math.max(y, area.y), area.y + area.height - 40),
  };
}

// Click-through is decided by main-side cursor polling against the hit
// areas the renderer reports: forwarded mouse-move alone is too flaky to
// trust with waking a click-through window up.
let hoverInteractive = false;
let hoverKind = null;
let panelOpen = false;
let hitAreas = { controls: [], dragTop: 0, dragBottom: 26 };
let hoverTimer = null;

function applyClickThrough(ignore) {
  if (!win || win.isDestroyed()) return;
  if (ignore) {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
  } else {
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
  }
}

function setHoverInteractive(value, kind = null) {
  if (!win || win.isDestroyed()) return;
  if (hoverInteractive === value && hoverKind === kind) return;
  hoverInteractive = value;
  hoverKind = value ? kind : null;
  applyClickThrough(!value);
}

function watchHover() {
  clearInterval(hoverTimer);
  hoverTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || panelOpen || dragState || resizeState) return;
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const contains = (rect) => point.x >= bounds.x + rect.x && point.x <= bounds.x + rect.x + rect.width
      && point.y >= bounds.y + rect.y && point.y <= bounds.y + rect.y + rect.height;
    const onControl = hitAreas.controls.some(contains);
    const onTopBar = point.x >= bounds.x && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y + hitAreas.dragTop && point.y <= bounds.y + hitAreas.dragBottom;
    setHoverInteractive(onControl || onTopBar, onControl ? 'control' : 'drag');
  }, 70);
}

function normalizeHitAreas(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const controls = (Array.isArray(source.controls) ? source.controls : []).flatMap((rect) => {
    if (!rect || typeof rect !== 'object') return [];
    const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) => Number(rect[key]));
    return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
      ? [{ x, y, width, height }]
      : [];
  });
  const top = Number(source.dragTop);
  const bottom = Number(source.dragBottom);
  return {
    controls,
    dragTop: Number.isFinite(top) ? top : 0,
    dragBottom: Number.isFinite(bottom) && bottom > top ? bottom : 26,
  };
}

function createWindow() {
  const width = settings.width;
  const height = settings.height;
  const bounds = clampBounds(Number(settings.left), Number(settings.top), width, height);
  settings.left = bounds.x;
  settings.top = bounds.y;

  win = new BrowserWindow({
    width,
    height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: settings.topmost,
    backgroundColor: '#00000000',
    transparent: true,
    roundedCorners: false,
    hasShadow: false,
    acceptFirstMouse: true,
    title: 'Busy Bird',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'web', 'index.html'));

  win.once('ready-to-show', () => win.showInactive());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
}

// ── drag from the renderer ──────────────────────────────────────────────────

let dragState = null;

function startDrag() {
  if (!win || win.isDestroyed() || dragState) return;
  const point = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.focus();
  const state = {
    pointerX: point.x,
    pointerY: point.y,
    windowX: x,
    windowY: y,
    timer: null,
    max: null,
  };
  state.timer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      endDrag();
      return;
    }
    const now = screen.getCursorScreenPoint();
    let nx = Math.round(state.windowX + now.x - state.pointerX);
    let ny = Math.round(state.windowY + now.y - state.pointerY);
    // Snap to the screen's centerlines: the perch likes the middle of the
    // desktop, and the guides in the renderer say when it took.
    const box = win.getBounds();
    const area = screen.getDisplayNearestPoint(now).workArea;
    const centerX = area.x + Math.round((area.width - box.width) / 2);
    const centerY = area.y + Math.round((area.height - box.height) / 2);
    const snapX = Math.abs(nx - centerX) <= 20;
    const snapY = Math.abs(ny - centerY) <= 20;
    if (snapX) nx = centerX;
    if (snapY) ny = centerY;
    if (snapX !== state.snapX || snapY !== state.snapY) {
      state.snapX = snapX;
      state.snapY = snapY;
      send('bird:snap', { x: snapX, y: snapY });
    }
    win.setPosition(nx, ny);
  }, 16);
  // A lost mouseup must not keep the window chasing the cursor forever.
  state.max = setTimeout(endDrag, 15000);
  dragState = state;
}

function endDrag() {
  if (!dragState) return;
  clearInterval(dragState.timer);
  clearTimeout(dragState.max);
  const wasSnapped = dragState.snapX || dragState.snapY;
  dragState = null;
  send('bird:snap', { x: false, y: false });
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    settings.left = x;
    settings.top = y;
    saveSettings();
    if (!wasSnapped) {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.setFocusable(false);
      win.blur();
    } else {
      // Keep the pointer for a beat on a snap, so the guides are seen.
      setTimeout(() => {
        if (win && !win.isDestroyed() && !dragState) {
          win.setIgnoreMouseEvents(true, { forward: true });
          win.setFocusable(false);
          win.blur();
        }
      }, 450);
    }
  }
  hoverInteractive = false;
  hoverKind = null;
}

// ── resize from the edges and corners ───────────────────────────────────────

let resizeState = null;

function startResize(direction = 'se') {
  if (!win || win.isDestroyed() || resizeState || dragState) return;
  const dir = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].includes(direction) ? direction : 'se';
  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const area = screen.getDisplayNearestPoint(point).workArea;
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.focus();
  const state = {
    dir,
    pointerX: point.x,
    pointerY: point.y,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    timer: null,
    max: null,
  };
  state.maxW = dir.includes('e') ? Math.max(bounds.width, area.x + area.width - bounds.x - 8)
    : Math.max(bounds.width, bounds.x + bounds.width - area.x - 8);
  state.maxH = dir.includes('s') ? Math.max(bounds.height, area.y + area.height - bounds.y - 8)
    : Math.max(bounds.height, bounds.y + bounds.height - area.y - 8);
  const minHeight = heightForWidth(MIN_WIDTH);
  state.timer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      endResize();
      return;
    }
    const now = screen.getCursorScreenPoint();
    const dx = now.x - state.pointerX;
    const dy = now.y - state.pointerY;
    let width = state.width;
    let height = state.height;
    let x = state.x;
    let y = state.y;
    if (dir.includes('e')) width = state.width + dx;
    else if (dir.includes('w')) width = state.width - dx;
    if (dir.includes('s')) height = state.height + dy;
    else if (dir.includes('n')) height = state.height - dy;
    // The canvas keeps its shape, so one dimension drives the other.
    if (dir.includes('e') || dir.includes('w')) height = heightForWidth(width);
    else width = widthForHeight(height);
    width = Math.max(MIN_WIDTH, Math.min(state.maxW, width));
    height = Math.max(minHeight, Math.min(state.maxH, height));
    if (dir.includes('w')) x = state.x + state.width - width;
    if (dir.includes('n')) y = state.y + state.height - height;
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }, false);
    settings.width = Math.round(width);
    settings.height = Math.round(height);
    settings.left = Math.round(x);
    settings.top = Math.round(y);
  }, 16);
  state.max = setTimeout(endResize, 15000);
  resizeState = state;
}

function endResize() {
  if (!resizeState) return;
  clearInterval(resizeState.timer);
  clearTimeout(resizeState.max);
  resizeState = null;
  saveSettings();
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.blur();
  }
  hoverInteractive = false;
  hoverKind = null;
}

// ── tray ────────────────────────────────────────────────────────────────────

function trayIcon() {
  const file = path.join(__dirname, '..', 'assets', 'icon.png');
  try {
    return nativeImage.createFromPath(file);
  } catch {
    return nativeImage.createEmpty();
  }
}

const PERIOD_LABELS = { today: '今日', '7d': '近 7 天', '30d': '近 30 天', all: '全部' };

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win.isVisible() ? '隐藏挂件' : '显示挂件', click: () => (win.isVisible() ? win.hide() : win.showInactive()) },
    { type: 'separator' },
    { label: '总在最前', type: 'checkbox', checked: Boolean(settings.topmost), click: (item) => {
      settings.topmost = item.checked;
      saveSettings();
      if (win) win.setAlwaysOnTop(settings.topmost, process.platform === 'darwin' ? 'floating' : 'normal');
    } },
    { label: '时间窗', submenu: PERIODS.map((period) => ({
      label: PERIOD_LABELS[period],
      type: 'radio',
      checked: settings.usagePeriod === period,
      click: () => {
        settings.usagePeriod = period;
        saveSettings();
        refreshUsage();
        send('bird:settings', publicSettings());
      },
    })) },
    { label: '不透明度', submenu: [0.2, 0.3, 0.4, 0.5, 0.7, 1].map((value) => ({
      label: `${Math.round(value * 100)}%`,
      type: 'radio',
      checked: Math.abs((Number(settings.opacity) || 0.34) - value) < 0.02,
      click: () => {
        settings.opacity = value;
        saveSettings();
        send('bird:settings', publicSettings());
      },
    })) },
    { type: 'separator' },
    { label: '退出', click: () => quitForGood() },
  ]));
}

function quitForGood() {
  quitting = true;
  try { fs.rmSync(path.join(app.getPath('appData'), 'Busy Bird', 'stopped'), { force: true }); } catch {}
  try { fs.writeFileSync(path.join(app.getPath('appData'), 'Busy Bird', 'stopped'), ''); } catch {}
  app.quit();
}

function touchAlive() {
  try {
    fs.mkdirSync(path.join(app.getPath('appData'), 'Busy Bird'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('appData'), 'Busy Bird', 'alive'), JSON.stringify({ at: Date.now() }));
    fs.rmSync(path.join(app.getPath('appData'), 'Busy Bird', 'stopped'), { force: true });
  } catch {}
}

// ── demo data, for --demo / --shot ──────────────────────────────────────────

const DEMO_AGENTS = ['dsh', 'Codex', 'Claude Code'];

function startDemo() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  let nextId = 1;
  let seq = 1;
  const accounts = ['workbuddy-ai/step-5', 'zen-free/deepseek-v4.1', 'team/gpt-5.2'];
  const quiet = process.argv.includes('--idle');
  const spawnRequest = () => {
    const agent = pick(DEMO_AGENTS);
    const route = {
      seq: seq++,
      id: 1792862888000 + nextId++,
      time: new Date().toISOString(),
      agent,
      provider: 'demo',
      model: 'demo/deepseek-v4.1-flash',
      order: [{ id: pick(accounts), provider: 'demo', name: 'Demo', who: 'demo', kind: 'account', plan: 'Free' }],
      tries: [],
      done: false,
    };
    setTimeout(() => {
      route.tries.push({
        id: route.order[0].id,
        model: route.model,
        start: new Date().toISOString(),
        done: false,
      });
      emit();
      setTimeout(() => {
        const attempt = route.tries[0];
        if (Math.random() < 0.18) {
          attempt.done = true;
          attempt.status = 500;
          attempt.fail = true;
          emit();
          setTimeout(() => {
            route.tries.push({ id: route.order[0].id, model: route.model, start: new Date().toISOString(), done: true, status: 200 });
            route.done = true;
            route.status = 200;
            emit();
          }, 1500);
        } else {
          attempt.done = true;
          attempt.status = 200;
          route.done = true;
          route.status = 200;
          emit();
        }
      }, 2500 + Math.random() * 3500);
    }, 700);
    emit();

    function emit() {
      trace = { seq: seq, now: new Date().toISOString(), object: 'trace', pid: 424242, routes: routes() };
      send('bird:trace', trace);
    }
    function routes() {
      const all = [...(trace ? trace.routes : []), route];
      return all.filter((item) => !item.done || Date.now() - new Date(item.time).getTime() < 12000);
    }
  };
  const schedule = () => {
    if (quiet) return;
    setTimeout(() => {
      spawnRequest();
      schedule();
    }, 2600 + Math.random() * 3400);
  };
  if (!quiet) {
    spawnRequest();
    schedule();
  }
  usageData = {
    period: 'today', calls: 128, input: 4821000, output: 233400, cache_read: 18200000,
    cost: 1.42, now: new Date().toISOString(),
  };
  send('bird:usage', usageData);
  connection = { online: true, detail: 'demo' };
  send('bird:connection', connection);
}

// ── ipc ─────────────────────────────────────────────────────────────────────

function publicSettings() {
  return {
    topmost: Boolean(settings.topmost),
    usagePeriod: settings.usagePeriod,
    gateway: resolveGateway(),
    opacity: Math.min(1, Math.max(0.05, Number(settings.opacity) || 0.34)),
    themeColor: typeof settings.themeColor === 'string' ? settings.themeColor : null,
  };
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

ipcMain.on('bird:ready', () => {
  send('bird:settings', publicSettings());
  if (trace) send('bird:trace', trace);
  send('bird:connection', connection);
  if (usageData) send('bird:usage', usageData);
});
ipcMain.on('bird:hit-areas', (_event, areas) => { hitAreas = normalizeHitAreas(areas); });
ipcMain.on('bird:drag-start', startDrag);
ipcMain.on('bird:drag-end', endDrag);
ipcMain.on('bird:resize-start', (_event, direction) => startResize(direction));
ipcMain.on('bird:resize-end', endResize);
ipcMain.on('bird:panel', (_event, open) => {
  panelOpen = Boolean(open);
  if (!win || win.isDestroyed()) return;
  if (panelOpen) {
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.focus();
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.blur();
  }
});
ipcMain.on('bird:save-settings', (_event, patch) => {
  if (!patch || typeof patch !== 'object') return;
  if (Number.isFinite(Number(patch.opacity))) {
    settings.opacity = Math.min(1, Math.max(0.05, Number(patch.opacity)));
  }
  if (typeof patch.themeColor === 'string' || patch.themeColor === null) {
    settings.themeColor = patch.themeColor;
  }
  saveSettings();
  send('bird:settings', publicSettings());
});
ipcMain.on('window:reset', () => {
  const area = screen.getPrimaryDisplay().workArea;
  settings.width = WIDTH;
  settings.height = HEIGHT;
  const bounds = clampBounds(
    area.x + Math.round((area.width - WIDTH) / 2),
    area.y + Math.round((area.height - HEIGHT) / 2),
    WIDTH, HEIGHT,
  );
  settings.left = bounds.x;
  settings.top = bounds.y;
  saveSettings();
  if (win && !win.isDestroyed()) {
    win.setBounds({ x: bounds.x, y: bounds.y, width: WIDTH, height: HEIGHT }, false);
  }
  send('bird:settings', publicSettings());
});
ipcMain.on('bird:period-next', () => {
  const index = PERIODS.indexOf(settings.usagePeriod);
  settings.usagePeriod = PERIODS[(index + 1) % PERIODS.length];
  saveSettings();
  refreshUsage();
  send('bird:settings', publicSettings());
});

// ── app lifecycle ───────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });

  app.whenReady().then(() => {
    loadSettings();
    createWindow();
    touchAlive();
    aliveTimer = setInterval(touchAlive, 10000);

    tray = new Tray(trayIcon());
    tray.setToolTip('Busy Bird');
    refreshTrayMenu();
    tray.on('click', () => (win.isVisible() ? win.hide() : win.showInactive()));

    if (IS_DEMO) {
      startDemo();
    } else {
      client = new TraceClient(resolveGateway());
      client.start();
      startUsageTimer();
    }
    watchHover();

    if (IS_SHOT) {
      const target = IS_SHOT.slice('--shot='.length);
      shotTimer = setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, image.toPNG());
          console.log(`[busy-bird] screenshot saved to ${target}`);
        } catch (error) {
          console.error(`[busy-bird] screenshot failed: ${error.message}`);
        }
        app.quit();
      }, 6000);
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    clearInterval(aliveTimer);
    clearInterval(usageTimer);
    clearInterval(hoverTimer);
    clearTimeout(shotTimer);
    if (client) client.stop();
  });

  app.on('window-all-closed', () => {
    // Stay resident in the tray; quitting goes through the tray menu.
  });
}
