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
const ISLAND_W = 236;
const ISLAND_H = 40;
// The stage keeps its shape: height follows width, so the SVG canvas scales
// instead of leaving bands.
const RATIO = WIDTH / (HEIGHT - TOPBAR_H);
const heightForWidth = (width) => Math.round(width / RATIO) + TOPBAR_H;
const widthForHeight = (height) => Math.round((height - TOPBAR_H) * RATIO);
const UPDATE_MS = 60 * 1000;

const IS_SHOT = process.argv.find((arg) => arg.startsWith('--shot='));
const IS_DEMO = process.argv.includes('--demo') || Boolean(IS_SHOT);
// A separate data directory lets a test instance run beside the real one.
if (process.env.BUSY_BIRD_DATA) {
  app.setPath('userData', process.env.BUSY_BIRD_DATA);
}

let win = null;
let tray = null;
let quitting = false;
let settings = null;
let settingsPath = null;
let logPath = null;
let trace = null;
let connection = { online: false, detail: '正在连接' };
let statsCache = null;
let statsAt = 0;
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

function log(message) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()}  ${message}\n`);
  } catch {
    // Logging must never take the widget down.
  }
}

function loadSettings() {
  settingsPath = path.join(app.getPath('appData'), 'Busy Bird', 'settings.json');
  logPath = path.join(app.getPath('appData'), 'Busy Bird', 'busy-bird.log');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    // First run, or the file does not read: fall back to defaults.
  }
  settings = { ...defaultSettings(), ...stored };
  settings.width = Math.min(Math.max(Number(settings.width) || WIDTH, MIN_WIDTH), 4000);
  settings.height = heightForWidth(settings.width);
  if (settings.docked) {
    // The island lives as a small window pinned to the top-centre edge.
    const area = screen.getPrimaryDisplay().workArea;
    settings.left = area.x + Math.round((area.width - ISLAND_W) / 2);
    settings.top = area.y;
  }
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
let expandState = false;
let hitAreas = { controls: [], dragTop: 0, dragBottom: 26 };
let hoverTimer = null;
let morphTimer = null;
let expandDwell = 0;
// The renderer tells us a press began: a grab is a drag, never an expand.
// It self-expires in case a mouseup is ever lost to a focus change.
let pressGrace = false;
let pressGraceUntil = 0;
// Just after a drop, the cursor still sits on the pill: hold off expanding
// for a moment so a placed island doesn't instantly balloon.
let recentlyPlaced = false;
let placedUntil = 0;

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
    if (!win || win.isDestroyed() || !win.isVisible() || panelOpen || dragState) return;
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    // Docked as the Dynamic Island: the window itself is only as big as the
    // pill. Resting the cursor on it grows the window into the full card;
    // leaving folds the card away again — the two modes never share space.
    if (settings.docked) {
      const inside = point.x >= bounds.x && point.x <= bounds.x + bounds.width
        && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
      // Expand on DWELL, not mere presence: a press that turns into a drag
      // suppresses expanding, so grabbing the pill never trips a resize.
      let wantExpand;
      if (expandState) {
        wantExpand = inside;
        if (!inside) expandDwell = 0;
      } else {
        if (pressGrace && Date.now() > pressGraceUntil) pressGrace = false;
        if (recentlyPlaced && Date.now() > placedUntil) recentlyPlaced = false;
        // Expanding waits on a deliberate dwell; a flick across the pill or
        // a grab that becomes a drag must never trigger the growth first.
        const dwellNeeded = recentlyPlaced ? 6 : 3;
        expandDwell = inside && !pressGrace && !recentlyPlaced ? expandDwell + 1 : 0;
        wantExpand = expandDwell >= dwellNeeded;
      }
      setHoverInteractive(true, expandState ? 'control' : 'drag');
      if (expandState !== wantExpand) {
        expandState = wantExpand;
        send('bird:expand', wantExpand);
        // A drag owns the window bounds: never start a resize under it.
        if (!dragState) morphToCard(wantExpand);
      }
      return;
    }
    const contains = (rect) => point.x >= bounds.x + rect.x && point.x <= bounds.x + rect.x + rect.width
      && point.y >= bounds.y + rect.y && point.y <= bounds.y + rect.y + rect.height;
    const onControl = hitAreas.controls.some(contains);
    const onTopBar = point.x >= bounds.x && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y + hitAreas.dragTop && point.y <= bounds.y + hitAreas.dragBottom;
    setHoverInteractive(onControl || onTopBar, onControl ? 'control' : 'drag');
  }, 70);
}

// Grow the small island window into the full card and back. The top edge
// stays put so the pill never jumps — the card unfolds below it. A morph is
// instantaneous while a drag owns the pointer, or the drag timer and the
function morphToCard(expand) {
  if (!win || win.isDestroyed()) return;
  // Re-entrant: a fold request mid-grow restarts from wherever the window
  // is now, so the hover state and the window size never drift apart.
  if (morphTimer) {
    clearInterval(morphTimer);
    morphTimer = null;
  }
  const bounds = win.getBounds();
  const area = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  }).workArea;
  const target = expand
    ? { x: area.x + Math.round((area.width - settings.width) / 2), y: area.y, width: settings.width, height: settings.height }
    : islandBounds(area);
  const steps = 5;
  let step = 0;
  morphTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(morphTimer);
      morphTimer = null;
      return;
    }
    step += 1;
    const k = step >= steps ? 1 : step / steps;
    win.setBounds({
      x: Math.round(bounds.x + (target.x - bounds.x) * k),
      y: target.y,
      width: Math.round(bounds.width + (target.width - bounds.width) * k),
      height: Math.round(bounds.height + (target.height - bounds.height) * k),
    }, false);
    if (step >= steps) {
      clearInterval(morphTimer);
      morphTimer = null;
    }
  }, 24);
}

// Settle a running morph to the size it was headed for: a drag must start
// from a stable window, not one mid-interpolation.
function finishMorph() {
  if (!win || win.isDestroyed() || !morphTimer) return;
  clearInterval(morphTimer);
  morphTimer = null;
  const bounds = win.getBounds();
  const area = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  }).workArea;
  const target = expandState
    ? { x: area.x + Math.round((area.width - settings.width) / 2), y: area.y, width: settings.width, height: settings.height }
    : islandBounds(area);
  win.setBounds(target, false);
}

function islandBounds(area) {
  return {
    x: area.x + Math.round((area.width - ISLAND_W) / 2),
    y: area.y,
    width: ISLAND_W,
    height: ISLAND_H,
  };
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
  let width = settings.width;
  let height = settings.height;
  if (settings.docked) {
    // Only the pill exists while the island is collapsed: a real small
    // window, not a hidden full-size one.
    width = ISLAND_W;
    height = ISLAND_H;
    const area = screen.getPrimaryDisplay().workArea;
    settings.left = area.x + Math.round((area.width - width) / 2);
    settings.top = area.y;
  }
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
  // Renderer warnings and errors land in the log: a dead flight loop must
  // leave a trace.
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const level = typeof ev?.level === 'number' ? ev.level : args[1];
    const message = typeof ev?.message === 'string' ? ev.message : args[2];
    if (level >= 2) log(`renderer: ${message}`);
  });
  // Right-click anywhere the card takes the pointer (top bar, island,
  // expanded stage): a compact menu with the skin switcher.
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: '换装', submenu: COURIERS.map(([value, label]) => ({
        label,
        type: 'radio',
        checked: (settings.courier || 'bird') === value,
        click: () => {
          settings.courier = value;
          saveSettings();
          send('bird:settings', publicSettings());
        },
      })) },
      { label: '灵动岛模式', type: 'checkbox', checked: Boolean(settings.docked), click: () => setDocked(!settings.docked) },
      { label: '恢复默认位置和大小', click: () => resetWindowPlace() },
      { type: 'separator' },
      { label: '退出', click: () => quitForGood() },
    ]).popup({ window: win });
  });
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
  // Grabbing the docked island always drags the PILL: fold an open card
  // back to the pill first, so a drag can never look like a growth.
  if (settings.docked) {
    clearInterval(morphTimer);
    morphTimer = null;
    expandState = false;
    expandDwell = 0;
    send('bird:expand', false);
    const cur = win.getBounds();
    const area = screen.getDisplayNearestPoint(cur).workArea;
    const nx = Math.min(Math.max(cur.x, area.x), area.x + area.width - ISLAND_W);
    win.setBounds({ x: nx, y: cur.y, width: ISLAND_W, height: ISLAND_H }, false);
  }
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
    // Dragging the docked island pins the pill's size on every tick: the
    // window can only move, never grow, whatever else touches its bounds.
    if (settings.docked) {
      clearInterval(morphTimer);
      morphTimer = null;
      if (expandState) {
        expandState = false;
        expandDwell = 0;
        send('bird:expand', false);
      }
      win.setBounds({ x: nx, y: ny, width: ISLAND_W, height: ISLAND_H }, false);
    } else {
      win.setPosition(nx, ny);
    }
    state.moved = true;
  }, 16);
  // A lost mouseup must not keep the window chasing the cursor forever.
  state.max = setTimeout(endDrag, 15000);
  dragState = state;
}

function endDrag() {
  if (!dragState) return;
  const moved = dragState.moved;
  clearInterval(dragState.timer);
  clearTimeout(dragState.max);
  dragState = null;
  send('bird:snap', { x: false, y: false });
  if (win && !win.isDestroyed()) {
    const area = screen.getDisplayNearestPoint(win.getBounds()).workArea;
    const bounds = win.getBounds();
    const nowCenterX = bounds.x + Math.round(bounds.width / 2);
    const nearTopCenter = bounds.y <= area.y + 20
      && Math.abs(nowCenterX - (area.x + Math.round(area.width / 2))) <= 60;
    if (moved && nearTopCenter) {
      // Dropped on the top-centre edge: dock. The window itself becomes the
      // island — the two modes never share space.
      expandState = false;
      send('bird:expand', false);
      settings.docked = true;
      win.setBounds(islandBounds(area), false);
      // The cursor is still on the pill: give it a beat before it may
      // expand again, or placing the island looks like it grew on its own.
      recentlyPlaced = true;
      placedUntil = Date.now() + 1200;
    } else if (moved && settings.docked) {
      // Dragged away from the edge: undock and grow back to the card.
      expandState = false;
      send('bird:expand', false);
      settings.docked = false;
      const b = clampBounds(bounds.x, bounds.y, settings.width, settings.height);
      win.setBounds({ x: b.x, y: b.y, width: settings.width, height: settings.height }, false);
    }
    const nb = win.getBounds();
    settings.left = nb.x;
    settings.top = nb.y;
    saveSettings();
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.blur();
  }
  hoverInteractive = false;
  hoverKind = null;
  send('bird:settings', publicSettings());
}

function setDocked(value) {
  settings.docked = Boolean(value);
  if (settings.docked) {
    const area = screen.getPrimaryDisplay().workArea;
    expandState = false;
    send('bird:expand', false);
    win?.setBounds(islandBounds(area), false);
  } else {
    expandState = false;
    const area = screen.getPrimaryDisplay().workArea;
    const x = area.x + Math.round((area.width - settings.width) / 2);
    const y = Math.max(area.y + 40, area.y + Math.round((area.height - settings.height) / 2));
    settings.left = x;
    settings.top = y;
    win?.setBounds({ x, y, width: settings.width, height: settings.height }, false);
  }
  saveSettings();
  send('bird:settings', publicSettings());
  refreshTrayMenu();
}

// ── size presets: the card keeps three fixed shapes ─────────────────────────

function setSize(width) {
  settings.width = Math.min(Math.max(Number(width) || WIDTH, MIN_WIDTH), 4000);
  settings.height = heightForWidth(settings.width);
  saveSettings();
  // The shape only changes while the card is open; the island has its own
  // fixed size, so it grows into the new card on the next hover.
  if (win && !win.isDestroyed() && !settings.docked) {
    win.setBounds({ x: settings.left, y: settings.top, width: settings.width, height: settings.height }, false);
  }
  send('bird:settings', publicSettings());
  refreshTrayMenu();
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
    { label: '换装', submenu: COURIERS.map(([value, label]) => ({
      label,
      type: 'radio',
      checked: (settings.courier || 'bird') === value,
      click: () => {
        settings.courier = value;
        saveSettings();
        send('bird:settings', publicSettings());
      },
    })) },
    { label: '尺寸', submenu: [[220, '小'], [260, '中'], [320, '大']].map(([width, label]) => ({
      label: `${label}（宽 ${width}）`,
      type: 'radio',
      checked: Number(settings.width) === width,
      click: () => setSize(width),
    })) },
    { label: '灵动岛模式（吸附屏幕顶部）', type: 'checkbox', checked: Boolean(settings.docked), click: () => setDocked(!settings.docked) },
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
    // Same brand demos the merged round trip: a DeepSeek harness served by a
    // DeepSeek account collapses to one chip and one wire.
    const accountId = agent === 'dsh' ? 'deepseek/deepseek-v4' : pick(accounts);
    const route = {
      seq: seq++,
      id: 1792862888000 + nextId++,
      time: new Date().toISOString(),
      agent,
      provider: 'demo',
      model: 'demo/deepseek-v4.1-flash',
      order: [{ id: accountId, provider: 'demo', name: 'Demo', who: 'demo', kind: 'account', plan: 'Free' }],
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

const COURIERS = [['bird', '小鸟'], ['car', '小车'], ['kiss', '亲嘴'], ['monkey', '猴子']];

function publicSettings() {
  return {
    topmost: Boolean(settings.topmost),
    usagePeriod: settings.usagePeriod,
    gateway: resolveGateway(),
    opacity: Math.min(1, Math.max(0.05, Number(settings.opacity) || 0.34)),
    themeColor: typeof settings.themeColor === 'string' ? settings.themeColor : null,
    docked: Boolean(settings.docked),
    courier: COURIERS.some(([value]) => value === settings.courier) ? settings.courier : 'bird',
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
ipcMain.on('bird:press', (_event, down) => {
  pressGrace = Boolean(down);
  pressGraceUntil = Date.now() + 800;
  if (pressGrace) expandDwell = 0;
});
ipcMain.on('bird:drag-start', startDrag);
ipcMain.on('bird:drag-end', endDrag);
ipcMain.on('bird:stats', async () => {
  if (statsCache && Date.now() - statsAt < 60000) {
    send('bird:stats', statsCache);
    return;
  }
  const base = resolveGateway();
  const grab = async (query) => {
    try {
      const response = await fetch(`${base}/v1/magpie/usage?${query}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  const [today, all, hourly] = await Promise.all([
    grab('period=today'),
    grab('period=all'),
    grab('period=today&bucket=hour'),
  ]);
  statsCache = { today, all, hourly };
  statsAt = Date.now();
  send('bird:stats', statsCache);
});
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
  if (typeof patch.docked === 'boolean' && patch.docked !== Boolean(settings.docked)) {
    setDocked(patch.docked);
    return;
  }
  saveSettings();
  send('bird:settings', publicSettings());
});
function resetWindowPlace() {
  const area = screen.getPrimaryDisplay().workArea;
  settings.width = WIDTH;
  settings.height = HEIGHT;
  if (settings.docked) {
    const b = islandBounds(area);
    settings.left = b.x;
    settings.top = b.y;
    if (win && !win.isDestroyed()) win.setBounds(b, false);
  } else {
    const bounds = clampBounds(
      area.x + Math.round((area.width - WIDTH) / 2),
      area.y + Math.round((area.height - HEIGHT) / 2),
      WIDTH, HEIGHT,
    );
    settings.left = bounds.x;
    settings.top = bounds.y;
    if (win && !win.isDestroyed()) {
      win.setBounds({ x: bounds.x, y: bounds.y, width: WIDTH, height: HEIGHT }, false);
    }
  }
  saveSettings();
  send('bird:settings', publicSettings());
}

ipcMain.on('window:reset', resetWindowPlace);
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
      const delay = Math.max(1000, Number(process.env.BUSY_BIRD_SHOT_MS) || 6000);
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
