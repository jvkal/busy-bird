// Busy Bird renderer: a perched magpie lives on the card, and every magpie
// request becomes a courier bird that flies agent → magpie → account and
// back. The flying magpie, wire curves and playback model follow
// yimi1mi/busy-magpie (MIT); the card around them is smaller and quieter.

import { wireCurve, hubCurve, glideProgress } from './flight-path.mjs';
import { MAGPIE_PATH } from './magpie-path.mjs';

const NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

const HUB = { left: 106, right: 154, y: 90, size: 34 };
const AGENT_X = 62;
const ACCOUNT_X = 198;
const MAX_LANES = 3;
// Lanes bunch toward the vertical center as the group count changes, so one
// quiet request flies a straight line through the hub instead of the top rail.
const laneY = (lane) => {
  const count = Math.min(Math.max(state.groups.size, 1), MAX_LANES);
  const positions = count === 1 ? [90] : count === 2 ? [66, 114] : [44, 90, 136];
  return positions[Math.min(lane, positions.length - 1)];
};
const BAD = '#ff6b6b';
const PALETTE = ['#a18bff', '#5be39a', '#61d7e7', '#ffb86b', '#ff7eb6', '#9ecbff', '#ffe066', '#7bd88f'];

// The same flying magpie magpie's own Routing page draws: facing right,
// wings beating from the shoulder, banked into the turn.
const FLIER =
  '<g class="rt-lift"><g transform="scale(1.2) translate(-6.5 3.2)">'
  + '<path class="wing far" d="M-14.5 -3.4C-16.5 -9.5 -14.2 -15 -8.6 -18.6C-9.4 -12.6 -9.6 -7.4 -9.2 -3.2Z"/>'
  + '<path class="tail" d="M-31.5 3.1L-18.6 -1.8L-17.4 1.2L-30.8 4.6Z"/>'
  + '<ellipse class="body" cx="-12.2" cy="-1.4" rx="7.6" ry="3.9"/>'
  + '<ellipse class="belly" cx="-12.8" cy="0.4" rx="4.3" ry="1.6"/>'
  + '<circle class="body" cx="-4.9" cy="-3.7" r="3.1"/>'
  + '<path class="body" d="M-2.3 -4.8L1.4 -3.3L-2.3 -2.2Z"/>'
  + '<g class="wing near"><path d="M-15.6 -3.2C-17.8 -10.2 -15.2 -16.4 -8.4 -20.4C-9.3 -13.6 -9.4 -7.8 -8.8 -2.8Z"/>'
  + '<path class="bar" d="M-14.6 -5.6C-15.4 -10.4 -13.8 -14.4 -10.4 -17.2"/></g>'
  + '</g></g>';

// ── helpers ─────────────────────────────────────────────────────────────────

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function colorFor(key) {
  let hash = 0;
  for (const ch of String(key)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

const requestActive = route => Boolean(route) && (!route.done || (route.tries || []).some(item => !item.done));
const groupKeyOf = route => `${route.agent || 'unknown'}|${route.session || route.conv || ''}`;

const succeeded = attempt => Number(attempt?.status) < 400 && !attempt.fail;

function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function shortName(value, limit = 10) {
  const text = String(value || '').trim();
  const tail = text.includes('/') ? text.split('/').pop() : text;
  return tail.length > limit ? `${tail.slice(0, limit - 1)}…` : tail;
}

// ── state ───────────────────────────────────────────────────────────────────

const state = {
  routes: new Map(),
  pid: 0,
  groups: new Map(),
  usage: null,
  usageAt: 0,
  settings: null,
  online: false,
};

const flights = new Map();
const wires = $('wires');
const chips = $('chips');
const hubLayer = $('hub');
const fx = $('fx');
const birdsLayer = $('birds');
const pill = $('pill');
const dot = $('dot');

// ── the card's hub: the perch magpie lives here ─────────────────────────────

const perchAnim = svgEl('g', { class: 'perch-anim' });
perchAnim.innerHTML = FLIER;
const perch = svgEl('g', { class: 'flying-bird perched' });
perch.style.setProperty('--agent', '#d4d4e0');
perch.append(perchAnim);
const hubGlyph = svgEl('path', { class: 'hub-glyph', 'fill-rule': 'evenodd', d: MAGPIE_PATH });
let hubBox = null;

function buildHub() {
  hubLayer.innerHTML = '';
  hubBox = svgEl('rect', {
    class: 'hub-box', x: HUB.left, y: HUB.y - 17, width: HUB.right - HUB.left, height: 34, rx: 8,
  });
  const glyph = svgEl('g', { transform: `translate(${(HUB.left + HUB.right) / 2 - 15} ${HUB.y - 15}) scale(0.68)` });
  glyph.append(hubGlyph);
  const glow = svgEl('circle', {
    class: 'hub-glow', cx: (HUB.left + HUB.right) / 2, cy: HUB.y, r: 30, fill: 'url(#glowGrad)',
  });
  hubLayer.append(glow, hubBox, glyph);
  // The perch bird stands on the hub card's top edge, facing right.
  perch.setAttribute('transform', `translate(${HUB.right - 4} ${HUB.y - 19}) scale(0.5)`);
  perch.style.display = 'none';
  birdsLayer.append(perch);
}

const GESTURES = ['hop', 'flutter', 'look'];

setInterval(() => {
  if (flights.size || !state.online) return;
  perch.classList.remove(...GESTURES);
  void document.body.offsetHeight;
  requestAnimationFrame(() => perch.classList.add(GESTURES[Math.floor(Math.random() * GESTURES.length)]));
}, 5200);

for (const gesture of GESTURES) {
  perchAnim.addEventListener('animationend', (event) => {
    if (event.animationName === 'hopUp' || event.animationName === 'flutterLift' || event.animationName === 'lookAround') {
      perch.classList.remove(gesture);
    }
  });
}

// ── groups and lanes ────────────────────────────────────────────────────────

function recomputeGroups() {
  const seen = new Set();
  for (const route of state.routes.values()) {
    const key = groupKeyOf(route);
    if (!requestActive(route) && ![...flights.values()].some(f => f.groupKey === key)) continue;
    seen.add(key);
    let group = state.groups.get(key);
    if (!group) {
      group = { key, agent: route.agent || 'unknown', color: colorFor(route.agent || 'unknown'), routes: [] };
      state.groups.set(key, group);
    }
    if (!group.routes.some(id => String(id) === String(route.id))) group.routes.push(route.id);
  }
  for (const [key, group] of state.groups) {
    if (seen.has(key)) continue;
    if (![...flights.values()].some(f => f.groupKey === key)) state.groups.delete(key);
  }
  let lane = 0;
  for (const group of state.groups.values()) group.lane = Math.min(lane++, MAX_LANES - 1);
}

function latestRouteOf(group) {
  let best = null;
  for (const route of state.routes.values()) {
    if (groupKeyOf(route) !== group.key) continue;
    if (!best || (Date.parse(route.time) || 0) > (Date.parse(best.time) || 0)) best = route;
  }
  return best;
}

// ── stage rendering ─────────────────────────────────────────────────────────

function chipLabel(agent) {
  return shortName(agent, 9);
}

function accountLabel(route) {
  const attempt = (route.tries || []).at(-1);
  const id = attempt?.id || route.order?.[0]?.id;
  return id ? shortName(id) : '…';
}

function render() {
  wires.innerHTML = '';
  chips.innerHTML = '';
  for (const group of state.groups.values()) {
    const accent = accentOf(group);
    const y = laneY(group.lane);
    const active = group.routes.some(id => requestActive(state.routes.get(String(id))));
    const inD = wireCurve({ x: AGENT_X, y }, { x: HUB.left, y: HUB.y, tx: 1, ty: 0 });
    const outD = wireCurve({ x: HUB.right, y: HUB.y, tx: 1, ty: 0 }, { x: ACCOUNT_X, y });
    if (active) {
      // a soft underglow under the live dashes
      const inGlow = svgEl('path', { class: 'wire glow', d: inD });
      const outGlow = svgEl('path', { class: 'wire glow', d: outD });
      inGlow.style.setProperty('--c', accent);
      outGlow.style.setProperty('--c', accent);
      wires.append(inGlow, outGlow);
    }
    const inPath = svgEl('path', { class: `wire${active ? ' live' : ''}`, d: inD });
    const outPath = svgEl('path', { class: `wire${active ? ' live' : ' resting'}`, d: outD });
    inPath.style.setProperty('--c', accent);
    outPath.style.setProperty('--c', accent);
    wires.append(inPath, outPath);
    // a burrow at each end: the courier tucks itself in there to wait
    const inBurrow = burrow(AGENT_X, y);
    const outBurrow = burrow(ACCOUNT_X, y);
    inBurrow.style.setProperty('--c', accent);
    outBurrow.style.setProperty('--c', accent);
    wires.append(inBurrow, outBurrow);

    const route = latestRouteOf(group);
    const count = group.routes.length;
    const agentText = chipLabel(group.agent) + (count > 1 ? ` ×${count}` : '');
    chips.append(chip(group, accent, agentText, accountLabel(route || {}), route?.model || '', route?.agent || ''));
  }
  const hubActive = [...state.routes.values()].some(requestActive);
  hubLayer.classList.toggle('active', hubActive);
  hubLayer.style.setProperty('--c', hubActive ? accentOf([...state.groups.values()][0]) || '' : '');
  perch.style.display = flights.size ? 'none' : '';
  perch.classList.toggle('sleep', !state.online);
}

const accentOf = group => state.settings?.themeColor || group.color;

// A little burrow at the wire's end: dark hole with an earth rim above it.
function burrow(x, y) {
  const g = svgEl('g', { class: 'burrow' });
  g.append(
    svgEl('path', { class: 'burrow-rim', d: `M ${x - 7} ${y} A 7 5.2 0 0 1 ${x + 7} ${y}` }),
    svgEl('ellipse', { class: 'burrow-hole', cx: x, cy: y, rx: 5.6, ry: 3.8 }),
  );
  return g;
}

function chip(group, accent, agentText, accountText, title, agentName) {
  const y = laneY(group.lane);
  const active = group.routes.some(id => requestActive(state.routes.get(String(id))));
  const g = svgEl('g');
  g.style.setProperty('--c', accent);
  const agentBox = svgEl('rect', {
    class: `chip-box${active ? ' live' : ''}`, x: 4, y: y - 10, width: 58, height: 20, rx: 7,
  });
  const agentDot = svgEl('circle', { class: `chip-dot${active ? ' pulse' : ''}`, cx: 12, cy: y, r: 2.7 });
  const agentLabel = svgEl('text', { class: 'chip-text', x: 18, y: y + 3 });
  agentLabel.textContent = agentText;
  const accountBox = svgEl('rect', {
    class: `chip-box${active ? ' live' : ''}`, x: 198, y: y - 10, width: 58, height: 20, rx: 7,
  });
  const accountNode = svgEl('text', { class: 'chip-sub', x: 204, y: y + 3 });
  accountNode.textContent = accountText;
  if (title) {
    const tip = svgEl('title');
    tip.textContent = `${agentName}\n${title}`;
    g.append(tip);
  }
  g.append(agentBox, agentDot, agentLabel, accountBox, accountNode);
  return g;
}

// ── flights ─────────────────────────────────────────────────────────────────

function anchorsOf(flight) {
  const y = laneY(flight.lane);
  return {
    agent: { x: AGENT_X, y },
    account: { x: ACCOUNT_X, y },
    hubL: { x: HUB.left, y: HUB.y, tx: 1, ty: 0 },
    hubR: { x: HUB.right, y: HUB.y, tx: 1, ty: 0 },
    size: HUB.size,
  };
}

// spec: ordered legs; each leg is one of the three guide paths, optionally
// flown backwards. Rebuilt whenever the lane or the spec changes.
function buildLegs(flight, spec) {
  const geoKey = `${flight.lane}|${spec.map(part => part.path + (part.reverse ? 'R' : '')).join(',')}`;
  if (flight.geoKey === geoKey && flight.length) return true;
  const a = anchorsOf(flight);
  const defs = {
    in: wireCurve(a.agent, a.hubL),
    out: wireCurve(a.hubR, a.account),
    through: hubCurve(a.hubL, a.hubR, a.size),
  };
  flight.geoKey = geoKey;
  flight.legs = spec.map((part) => {
    const path = flight.paths[part.path === 'in' ? 0 : part.path === 'out' ? 1 : 2];
    path.setAttribute('d', defs[part.path]);
    return { path, reverse: Boolean(part.reverse), length: 0 };
  });
  flight.legs.forEach((leg) => { leg.length = leg.path.getTotalLength(); });
  flight.length = flight.legs.reduce((sum, leg) => sum + leg.length, 0);
  return flight.length > 0;
}

function flightPoint(flight, distance) {
  let remaining = Math.max(0, Math.min(flight.length, distance));
  let index = 0;
  while (index < flight.legs.length - 1 && remaining > flight.legs[index].length) {
    remaining -= flight.legs[index++].length;
  }
  const { path, reverse, length } = flight.legs[index];
  return path.getPointAtLength(reverse ? length - remaining : remaining);
}

function poseBird(flight, p, vx, vy, scale = 0.72) {
  const flip = vx < 0 ? -1 : 1;
  const aim = Math.max(-22, Math.min(22, Math.atan2(vy, Math.abs(vx) || 1) * 180 / Math.PI));
  if (flight.aim === null || flight.aimFlip !== (vx < 0)) flight.aim = aim;
  else flight.aim += (aim - flight.aim) * 0.14;
  flight.aimFlip = vx < 0;
  flight.bird.setAttribute('transform',
    `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${flip * scale} ${scale}) rotate(${flight.aim.toFixed(2)})`);
}

function ripple() {
  const accent = hubLayer.style.getPropertyValue('--c') || '#a18bff';
  const circle = svgEl('circle', { class: 'ripple', cx: (HUB.left + HUB.right) / 2, cy: HUB.y });
  circle.style.setProperty('--c', accent);
  fx.append(circle);
  hubLayer.classList.add('passing');
  window.setTimeout(() => {
    circle.remove();
    hubLayer.classList.remove('passing');
  }, 700);
}

function flyTo(flight, spec, ms) {
  return new Promise((resolve) => {
    const started = performance.now();
    let crossed = false;
    const step = (now) => {
      if (flight.cancelled) { resolve(); return; }
      if (!buildLegs(flight, spec)) { resolve(); return; }
      const progress = Math.max(0, Math.min(1, (now - started) / ms));
      const distance = glideProgress(progress) * flight.length;
      if (!crossed) {
        const crossAt = crossingDistance(spec, flight);
        if (crossAt >= 0 && distance >= crossAt) {
          crossed = true;
          ripple();
        }
      }
      const p = flightPoint(flight, distance);
      const p0 = flightPoint(flight, distance - 3);
      const p1 = flightPoint(flight, distance + 3);
      let vx = p1.x - p0.x, vy = p1.y - p0.y;
      if (Math.abs(vx) + Math.abs(vy) < 0.01) vx = 1;
      poseBird(flight, p, vx, vy);
      if (progress < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

function setPose(flight, pose) {
  const held = pose.includes('hold');
  flight.bird.classList.toggle('back', pose.includes('back'));
  flight.bird.classList.toggle('failed', pose.includes('failed'));
  flight.bird.classList.toggle('held', held);
  // The courier pops out of the burrow when it flies again.
  flight.flier.classList.toggle('carrying', !held);
}

// Waiting happens inside a burrow: the bird hides and only the packet it
// delivered keeps glowing at the hole mouth.
function holdAt(flight, where) {
  setPose(flight, `hold-${where}`);
  if (where === 'hub') {
    flight.bird.setAttribute('transform', `translate(${HUB.left + 2} ${HUB.y}) scale(0.72)`);
  } else {
    flight.bird.setAttribute('transform', `translate(${ACCOUNT_X} ${laneY(flight.lane)}) scale(0.72)`);
  }
}

const LEGS_TO_HUB = [{ path: 'in' }];
const LEGS_TO_ACCOUNT = [{ path: 'through' }, { path: 'out' }];
const LEGS_RETURN = [{ path: 'out', reverse: true }, { path: 'through', reverse: true }, { path: 'in', reverse: true }];
const LEGS_BACK_TO_HUB = [{ path: 'out', reverse: true }];

// The crossing of the hub happens halfway through the through-leg. Read
// lazily, AFTER the legs are built: the previous spec's legs are stale here.
function crossingDistance(spec, flight) {
  if (spec === LEGS_TO_ACCOUNT || spec === LEGS_RETURN) {
    return flight.legs[0].length + flight.legs[1].length / 2;
  }
  return -1;
}

const TRAVEL_MS = new Map([
  [LEGS_TO_HUB, 720],
  [LEGS_TO_ACCOUNT, 920],
  [LEGS_RETURN, 1350],
  [LEGS_BACK_TO_HUB, 620],
]);

function travel(flight, spec) {
  return flyTo(flight, spec, TRAVEL_MS.get(spec) || 900);
}

function waitFor(flight, predicate) {
  return new Promise((resolve) => {
    const timer = window.setInterval(() => {
      if (flight.cancelled || predicate(flight.route)) {
        window.clearInterval(timer);
        resolve(!flight.cancelled);
      }
    }, 180);
  });
}

function fadeOut(flight) {
  if (flight.dismissing) return;
  flight.dismissing = true;
  flight.bird.style.opacity = '0';
  window.setTimeout(() => dispose(flight), 380);
}

function dispose(flight) {
  if (flight.cancelled && !flight.bird.isConnected) return;
  flight.cancelled = true;
  flight.bird.remove();
  flight.guides.remove();
  flights.delete(flight.id);
  render();
}

function startFlight(route) {
  const id = String(route.id);
  const key = groupKeyOf(route);
  const group = state.groups.get(key);
  const color = group ? group.color : colorFor(route.agent);
  const bird = svgEl('g', { class: 'flying-bird' });
  bird.style.setProperty('--agent', color);
  bird.style.opacity = '0';
  const flier = svgEl('g', { class: 'flier' });
  flier.innerHTML = FLIER;
  const packet = svgEl('circle', { class: 'packet', r: 3, cx: 0, cy: 0 });
  bird.append(flier, packet);
  const guides = svgEl('g');
  const paths = ['in', 'out', 'through'].map(() => {
    const path = svgEl('path', { fill: 'none', stroke: 'none' });
    guides.append(path);
    return path;
  });
  birdsLayer.append(guides, bird);
  const flight = {
    id, groupKey: key, route, bird, flier, packet, guides, paths,
    lane: group ? group.lane : 0, geoKey: '', legs: [], length: 0,
    aim: null, aimFlip: false, cancelled: false, dismissing: false,
  };
  flights.set(id, flight);
  window.requestAnimationFrame(() => { bird.style.opacity = '1'; });
  // A thrown playback must not leave an orphan bird on the sky.
  runFlight(flight).catch((error) => {
    console.warn('[busy-bird] flight playback failed:', error);
    dispose(flight);
  });
}

async function runFlight(flight) {
  try {
    setPose(flight, 'fly');
    if (!await travel(flight, LEGS_TO_HUB)) return;
    holdAt(flight, 'hub');
    await waitFor(flight, route => (route.tries || []).length > 0 || route.done);
    let index = 0;
    while (!flight.cancelled) {
      const route = flight.route;
      if (route.done && !(route.tries || []).length) { fadeOut(flight); return; }
      if (!(route.tries || [])[index]) {
        holdAt(flight, 'hub');
        await waitFor(flight, r => (r.tries || [])[index] || r.done);
        if (flight.cancelled) return;
        if (flight.route.done && !(flight.route.tries || [])[index]) { fadeOut(flight); return; }
      }
      setPose(flight, 'fly');
      if (!await travel(flight, LEGS_TO_ACCOUNT)) return;
      holdAt(flight, 'account');
      await waitFor(flight, r => Boolean((r.tries || [])[index]?.done));
      if (flight.cancelled) return;
      const attempt = flight.route.tries[index];
      if (succeeded(attempt)) {
        await waitFor(flight, r => r.done);
        if (flight.cancelled) return;
        setPose(flight, 'back');
        if (!await travel(flight, LEGS_RETURN)) return;
        fadeOut(flight);
        return;
      }
      const hasNext = (flight.route.tries || []).length > index + 1;
      if (!hasNext && flight.route.done) {
        setPose(flight, 'back failed');
        if (!await travel(flight, LEGS_RETURN)) return;
        fadeOut(flight);
        return;
      }
      setPose(flight, 'fly failed');
      if (!await travel(flight, LEGS_BACK_TO_HUB)) return;
      holdAt(flight, 'hub');
      index += 1;
      await waitFor(flight, r => Boolean((r.tries || [])[index]));
    }
  } finally {
    // A fading flight owns its own delayed dispose; only an abrupt exit
    // (cancellation, reset) cleans up here.
    if (flights.has(flight.id) && !flight.dismissing) dispose(flight);
  }
}

// ── trace intake ────────────────────────────────────────────────────────────

function applyTrace(data) {
  if (!data) return;
  const pid = Number(data.pid) || 0;
  if (state.pid && pid && pid !== state.pid) {
    for (const flight of [...flights.values()]) dispose(flight);
    state.routes.clear();
    state.groups.clear();
  }
  state.pid = pid || state.pid;
  for (const route of Array.isArray(data.routes) ? data.routes : []) {
    state.routes.set(String(route.id), route);
  }
  while (state.routes.size > 120) {
    const done = [...state.routes.values()].filter(route => route.done)
      .sort((a, b) => new Date(a.time) - new Date(b.time));
    if (!done.length) break;
    state.routes.delete(String(done[0].id));
  }
  recomputeGroups();
  for (const [id, flight] of flights) {
    const route = state.routes.get(id);
    if (route) {
      flight.route = route;
      const group = state.groups.get(flight.groupKey);
      if (group && group.lane !== flight.lane) flight.lane = group.lane;
    } else if (!flight.dismissing) {
      fadeOut(flight);
    }
  }
  for (const [id, route] of state.routes) {
    if (!flights.has(id) && requestActive(route)) startFlight(route);
  }
  render();
}

// ── pill, dot, connection ───────────────────────────────────────────────────

const PERIOD_LABELS = { today: '今日', '7d': '近 7 天', '30d': '近 30 天', all: '全部' };

function usageTotal(data) {
  if (!data) return 0;
  return (Number(data.input) || 0) + (Number(data.output) || 0)
    + (Number(data.cache_read) || 0) + (Number(data.cache_write) || 0);
}

function renderPill() {
  const period = state.settings?.usagePeriod || 'today';
  if (!state.usage) {
    pill.textContent = `— tok · ${PERIOD_LABELS[period] || period}`;
    pill.classList.add('stale');
    pill.title = state.online ? '尚未读到用量' : '未连接 magpie';
    return;
  }
  pill.classList.toggle('stale', !state.online);
  const fresh = Date.now() - state.usageAt < 120000;
  pill.classList.toggle('stale', !fresh);
  pill.textContent = `${fmtTokens(usageTotal(state.usage))} tok · ${PERIOD_LABELS[period] || period}`;
  const u = state.usage;
  pill.title = ['输入 ' + fmtTokens(u.input), '输出 ' + fmtTokens(u.output),
    '缓存读 ' + fmtTokens(u.cache_read), `调用 ${u.calls ?? '—'}`].join('　');
}

function renderDot() {
  dot.classList.toggle('ok', state.online);
  dot.classList.toggle('bad', !state.online);
  dot.title = state.online ? `实时 · ${state.detail || ''}` : `重连中 · ${state.detail || ''}`;
}

// ── wiring ──────────────────────────────────────────────────────────────────

function applyOpacity(value) {
  const alpha = Math.min(1, Math.max(0.05, Number(value) || 0.34));
  document.body.style.background = `linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0) 42%), `
    + `linear-gradient(rgba(16,16,24,${alpha}), rgba(16,16,24,${alpha}))`;
}

// The main process polls the cursor against these rectangles to decide when
// the click-through card wakes up and takes the pointer.
function reportHitAreas() {
  const controls = [...document.querySelectorAll('.hot')]
    .filter(el => el.getClientRects().length)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  window.bird?.hitAreas({ controls, dragTop: 0, dragBottom: 26 });
}
window.addEventListener('resize', reportHitAreas);

// ── settings panel ──────────────────────────────────────────────────────────

const panel = $('panel');
const gear = $('gear');
panel.classList.add('hot');

const SWATCHES = [null, '#a18bff', '#5be39a', '#61d7e7', '#ffb86b', '#ff7eb6', '#9ecbff', '#ffe066'];
let saveTimer = 0;

function savePatch(patch) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => window.bird?.saveSettings(patch), 250);
}

function applyTheme(color) {
  document.body.style.setProperty('--theme', color || '#a18bff');
  render();
}

function syncPanel() {
  const s = state.settings || {};
  const op = Math.round((Number(s.opacity) || 0.34) * 100);
  $('opSlider').value = op;
  $('opVal').textContent = `${op}%`;
  const theme = s.themeColor || null;
  for (const btn of document.querySelectorAll('.swatch')) {
    btn.classList.toggle('on', (btn.dataset.color || null) === theme);
  }
  $('customColor').value = theme || '#a18bff';
}

function togglePanel(open) {
  panel.classList.toggle('open', open);
  window.bird?.panel(open);
  if (open) syncPanel();
  reportHitAreas();
}

gear.addEventListener('click', () => togglePanel(!panel.classList.contains('open')));
$('panelClose').addEventListener('click', () => togglePanel(false));

for (const color of SWATCHES) {
  const btn = document.createElement('button');
  btn.className = color ? 'swatch' : 'swatch auto';
  btn.title = color || '跟随 Agent 配色';
  btn.dataset.color = color || '';
  if (color) btn.style.background = color;
  btn.addEventListener('click', () => {
    state.settings = { ...state.settings, themeColor: color };
    applyTheme(color);
    savePatch({ themeColor: color });
    syncPanel();
  });
  $('swatches').append(btn);
}

$('customColor').addEventListener('input', (event) => {
  const color = event.target.value;
  state.settings = { ...state.settings, themeColor: color };
  applyTheme(color);
  savePatch({ themeColor: color });
  for (const btn of document.querySelectorAll('.swatch')) btn.classList.remove('on');
});

$('opSlider').addEventListener('input', (event) => {
  const value = Number(event.target.value) / 100;
  applyOpacity(value);
  $('opVal').textContent = `${event.target.value}%`;
  state.settings = { ...state.settings, opacity: value };
  savePatch({ opacity: value });
});

$('resetPlace').addEventListener('click', () => window.bird?.resetPlace());

// ── drag from the top strip, resize from the edges ─────────────────────────

pill.addEventListener('click', () => window.bird?.periodNext());

const topbar = $('topbar');
topbar.addEventListener('mousedown', (event) => {
  if (event.target.closest('.pill') || event.target.closest('.gear')) return;
  event.preventDefault();
  window.bird?.dragStart();
});

for (const band of document.querySelectorAll('.rz')) {
  band.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.bird?.resizeStart(band.dataset.dir);
  });
}

window.addEventListener('mouseup', () => {
  window.bird?.dragEnd();
  window.bird?.resizeEnd();
});

window.bird?.onTrace(applyTrace);
window.bird?.onConnection((connection) => {
  state.online = Boolean(connection.online);
  state.detail = connection.detail || '';
  renderDot();
  render();
});
window.bird?.onUsage((usage) => {
  state.usage = usage;
  state.usageAt = Date.now();
  renderPill();
});
window.bird?.onSettings((settings) => {
  state.settings = settings;
  applyOpacity(settings.opacity);
  applyTheme(settings.themeColor);
  renderPill();
  if (panel.classList.contains('open')) syncPanel();
});
window.bird?.onSnap(({ x, y }) => {
  document.body.classList.toggle('snap-x', Boolean(x));
  document.body.classList.toggle('snap-y', Boolean(y));
});

buildHub();
applyOpacity(state.settings?.opacity);
applyTheme(state.settings?.themeColor);
render();
renderDot();
renderPill();
reportHitAreas();
window.setTimeout(reportHitAreas, 800);
window.bird?.ready();
