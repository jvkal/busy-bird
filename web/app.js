// Busy Bird renderer: a perched magpie lives on the card, and every magpie
// request becomes a courier bird that flies agent → magpie → account and
// back. The flying magpie, wire curves and playback model follow
// yimi1mi/busy-magpie (MIT); the card around them is smaller and quieter.

import { wireCurve, hubCurve, glideProgress } from './flight-path.mjs';
import { MAGPIE_PATH } from './magpie-path.mjs';

const NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

const HUB = { left: 106, right: 154, y: 90, size: 34 };
const AGENT_X = 66;
const ACCOUNT_X = 194;
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

const capFirst = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ── brand marks (icons from busy-magpie, MIT licensed) ──────────────────────

const brandSources = window.bird?.brandIcons || {};
const brandTemplates = new Map();
const AGENT_BRANDS = {
  codex: 'openai', openai: 'openai', claude: 'claudecode-color', 'claude-code': 'claudecode-color',
  claudecode: 'claudecode-color', 'claude-desktop': 'claude-color', dsh: 'deepseek-color',
  deepseek: 'deepseek-color', cursor: 'cursor', opencode: 'opencode', gemini: 'gemini-color',
  'gemini-cli': 'geminicli-color', geminicli: 'geminicli-color', kimi: 'kimi', 'kimi-code': 'kimi',
  qoder: 'qoder', pi: 'pi', grok: 'grok', zcode: 'zhipu-color',
};
const PROVIDER_BRANDS = {
  openai: 'openai', codex: 'openai', anthropic: 'anthropic', claude: 'claude-color',
  google: 'google-color', gemini: 'gemini-color', deepseek: 'deepseek-color',
  openrouter: 'openrouter', xai: 'xai', grok: 'grok', kimi: 'kimi', moonshot: 'kimi',
  qwen: 'qwen-color', zhipu: 'zhipu-color', zcode: 'zhipu-color',
};
const MONO_BRANDS = new Set(['openai', 'anthropic', 'cursor', 'opencode', 'pi', 'grok', 'xai', 'openrouter', 'kimi']);

function brandKeyOf(value, kind) {
  const key = String(value || '').trim().toLowerCase().replace(/\.svg$/, '').replace(/-color$/, '').replace(/\s+/g, '-');
  return (kind === 'provider' ? PROVIDER_BRANDS : AGENT_BRANDS)[key] || '';
}

// A nested <svg> placed at x/y and scaled to size; null when the brand is
// unknown so the caller can fall back to a plain dot.
function brandMark(key, x, y, size) {
  if (!key || !brandSources[key]) return null;
  if (!brandTemplates.has(key)) {
    const parsed = new DOMParser().parseFromString(brandSources[key], 'image/svg+xml').documentElement;
    if (parsed.localName !== 'svg') return null;
    parsed.removeAttribute('style');
    if (!parsed.getAttribute('viewBox')) {
      const w = Number(parseFloat(parsed.getAttribute('width'))) || 16;
      const h = Number(parseFloat(parsed.getAttribute('height'))) || 16;
      parsed.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    parsed.removeAttribute('width');
    parsed.removeAttribute('height');
    brandTemplates.set(key, parsed);
  }
  const svg = document.importNode(brandTemplates.get(key), true);
  svg.setAttribute('x', x);
  svg.setAttribute('y', y);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', `brand-mark${MONO_BRANDS.has(key) ? ' mono' : ''}`);
  return svg;
}

const AGENT_NAMES = { dsh: 'DeepSeek Harness' };

function accountOf(route) {
  const attempt = (route.tries || []).at(-1);
  return attempt?.id || route.order?.[0]?.id || route.provider || '';
}

// When the account on the right belongs to the same agent or vendor as the
// sender on the left, the trip collapses to one chip and one wire.
function isMerged(route) {
  const agent = String(route?.agent || '').toLowerCase();
  if (!agent) return false;
  const id = String(accountOf(route)).toLowerCase();
  if (!id) return false;
  const provider = String(route?.order?.[0]?.provider || route?.provider || '').toLowerCase();
  return id === agent || provider === agent || id.split('/')[0] === agent;
}

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
const island = $('island');

// ── the card's hub: the perch magpie lives here ─────────────────────────────

const perchAnim = svgEl('g', { class: 'perch-anim' });
perchAnim.innerHTML = FLIER;
const perch = svgEl('g', { class: 'flying-bird perched' });
perch.style.setProperty('--agent', '#d4d4e0');
perch.append(perchAnim);
const hubGlyph = svgEl('path', { class: 'hub-glyph', 'fill-rule': 'evenodd', d: MAGPIE_PATH });
let hubBox = null;
let hubAddrText = null;

function buildHub() {
  hubLayer.innerHTML = '';
  hubBox = svgEl('rect', {
    class: 'hub-box', x: HUB.left, y: HUB.y - 21, width: HUB.right - HUB.left, height: 42, rx: 9,
  });
  const glyph = svgEl('g', { transform: `translate(${(HUB.left + HUB.right) / 2 - 11} ${HUB.y - 18}) scale(0.5)` });
  glyph.append(hubGlyph);
  const glow = svgEl('circle', {
    class: 'hub-glow', cx: (HUB.left + HUB.right) / 2, cy: HUB.y, r: 30, fill: 'url(#glowGrad)',
  });
  const nameText = svgEl('text', { class: 't-brand', x: (HUB.left + HUB.right) / 2, y: HUB.y + 7, 'text-anchor': 'middle' });
  nameText.textContent = 'magpie';
  hubAddrText = svgEl('text', { class: 't-addr', x: (HUB.left + HUB.right) / 2, y: HUB.y + 16, 'text-anchor': 'middle' });
  hubLayer.append(glow, hubBox, glyph, nameText, hubAddrText);
  // The perch bird stands on the hub card's top edge, facing right.
  perch.setAttribute('transform', `translate(${HUB.right - 4} ${HUB.y - 24}) scale(0.5)`);
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
  for (const group of state.groups.values()) group.merged = isMerged(latestRouteOf(group) || {});
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

function statusText(route) {
  if (!route) return '排队中…';
  if (route.done) {
    return Number(route.status) >= 400 ? `回答失败 · ${route.status}` : '回答了这个请求';
  }
  return (route.tries || []).length ? '回答中…' : '排队中…';
}

function badgeText(route) {
  const attempt = (route?.tries || []).at(-1);
  const value = attempt?.served || String(route?.model || '').split('/')[1] || '';
  return value ? shortName(value, 12) : '';
}

function agentCard(group, accent, route, count, active) {
  const y = laneY(group.lane);
  const g = svgEl('g');
  g.style.setProperty('--c', accent);
  g.append(svgEl('rect', {
    class: `card-box${active ? ' live' : ''}`, x: 2, y: y - 21, width: 64, height: 42, rx: 9,
  }));
  const name = capFirst(AGENT_NAMES[group.agent] || group.agent || 'unknown');
  const model = String(route?.model || '').split('/')[1] || '';
  const icon = brandMark(brandKeyOf(group.agent, 'agent'), 25, y - 18, 14);
  if (icon) g.append(icon);
  else g.append(svgEl('circle', { class: 'chip-dot', cx: 32, cy: y - 11, r: 4 }));
  const nameText = svgEl('text', { class: 't-name', x: 34, y: y + 4, 'text-anchor': 'middle' });
  nameText.textContent = shortName(name, 9) + (count > 1 ? ` ×${count}` : '');
  const modelText = svgEl('text', { class: 't-model', x: 34, y: y + 14, 'text-anchor': 'middle' });
  modelText.textContent = shortName(model, 13);
  g.append(nameText, modelText);
  if (route?.model) {
    const tip = svgEl('title');
    tip.textContent = `${name}\n${route.model}\n${statusText(route)}`;
    g.append(tip);
  }
  return g;
}

function accountCard(group, accent, route, active) {
  const y = laneY(group.lane);
  const g = svgEl('g');
  g.style.setProperty('--c', accent);
  g.append(svgEl('rect', {
    class: `card-box${active ? ' live' : ''}`, x: 194, y: y - 21, width: 62, height: 42, rx: 9,
  }));
  const seat = route?.order?.[0] || {};
  const attempt = (route?.tries || []).at(-1);
  const who = seat.who || seat.name || accountOf(route || {});
  const failed = route?.done && Number(route.status) >= 400;
  const done = route?.done && !failed;
  // status dot
  g.append(svgEl('circle', {
    class: `status-dot${active ? ' pulse' : ''}`,
    cx: 201, cy: y - 13, r: 2.4,
    fill: failed ? BAD : done ? 'rgba(255,255,255,0.35)' : 'var(--c, #a18bff)',
  }));
  // brand icon or a plain dot
  const iconKey = brandKeyOf(seat.icon, 'provider') || brandKeyOf(seat.provider || route?.provider, 'provider');
  const icon = brandMark(iconKey, 207, y - 18, 11);
  if (icon) g.append(icon);
  // account name
  const nameText = svgEl('text', { class: 't-sub', x: icon ? 221 : 207, y: y - 9 });
  nameText.textContent = shortName(who, icon ? 7 : 10);
  // status line
  const status = svgEl('text', { class: 't-status', x: 200, y: y + 5 });
  status.textContent = statusText(route);
  // model badge, right aligned on the status row
  const badge = badgeText(route);
  if (badge) {
    const bw = badge.length * 3.8 + 8;
    g.append(svgEl('rect', { class: 'badge-box', x: 254 - bw, y: y - 2, width: bw, height: 11, rx: 4 }));
    const badgeTextEl = svgEl('text', { class: 'badge-text', x: 254 - bw / 2, y: y + 5.8, 'text-anchor': 'middle' });
    badgeTextEl.textContent = badge;
    g.append(badgeTextEl);
  }
  // progress underline: a live shimmer while answering, quiet when done
  g.append(svgEl('rect', { class: 'bar-track', x: 200, y: y + 10, width: 54, height: 2, rx: 1 }));
  g.append(svgEl('rect', {
    class: `bar-fill${failed ? ' fail' : ''}${active ? ' busy' : ''}`,
    x: 200, y: y + 10, width: 54, height: 2, rx: 1,
  }));
  if (route?.model || seat.who) {
    const tip = svgEl('title');
    tip.textContent = `${who}${seat.name ? ` · ${seat.name}` : ''}${seat.plan ? ` · ${seat.plan}` : ''}\n${badgeText(route)}`;
    g.append(tip);
  }
  return g;
}

function render() {
  wires.innerHTML = '';
  chips.innerHTML = '';
  for (const group of state.groups.values()) {
    const accent = accentOf(group);
    const y = laneY(group.lane);
    const route = latestRouteOf(group);
    const active = group.routes.some(id => requestActive(state.routes.get(String(id))));
    const attempt = (route?.tries || []).at(-1);
    // Official Routing semantics: the request's ride to magpie is a solid
    // line, the answer's ride back is dashed until it is done.
    const inD = wireCurve({ x: AGENT_X, y }, { x: HUB.left, y: HUB.y, tx: 1, ty: 0 });
    wires.append(wire(inD, accent, 'line', active));
    if (!group.merged) {
      if (active) {
        const outGlow = svgEl('path', {
          class: 'wire glow',
          d: wireCurve({ x: HUB.right, y: HUB.y, tx: 1, ty: 0 }, { x: ACCOUNT_X, y }),
        });
        outGlow.style.setProperty('--c', accent);
        wires.append(outGlow);
      }
      const pending = active && !(attempt && attempt.done);
      wires.append(wire(
        wireCurve({ x: HUB.right, y: HUB.y, tx: 1, ty: 0 }, { x: ACCOUNT_X, y }),
        accent, pending ? 'live' : 'line', active,
      ));
    }
    // a burrow at the wire's end: the courier tucks itself in there to wait.
    // A merged trip comes back to the same burrow, so there is only one.
    const inBurrow = burrow(AGENT_X, y);
    inBurrow.style.setProperty('--c', accent);
    wires.append(inBurrow);
    if (!group.merged) {
      const outBurrow = burrow(ACCOUNT_X, y);
      outBurrow.style.setProperty('--c', accent);
      wires.append(outBurrow);
    }

    const count = group.routes.length;
    chips.append(agentCard(group, accent, route, count, active));
    if (!group.merged) chips.append(accountCard(group, accent, route, active));
  }
  const hubActive = [...state.routes.values()].some(requestActive);
  hubLayer.classList.toggle('active', hubActive);
  hubLayer.style.setProperty('--c', hubActive ? accentOf([...state.groups.values()][0]) || '' : '');
  if (hubAddrText) {
    hubAddrText.textContent = String(state.detail || state.settings?.gateway || '')
      .replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
  perch.style.display = flights.size ? 'none' : '';
  perch.classList.toggle('sleep', !state.online);
  updateIsland();
}

// ── the docked island: two ends, a dashed channel, running lights ──────────

const islLights = $('islLights');
const islLeft = $('islLeft');
const islRight = $('islRight');
const islText = $('islText');
const islBirds = $('islBirds');
const islPacket = $('islPacket');

let islBird = null;

function ensureIslandBird() {
  if (islBird) return islBird;
  const g = svgEl('g', { class: 'flying-bird isl-bird perched' });
  g.style.opacity = '1';
  const flier = svgEl('g', { class: 'flier' });
  flier.innerHTML = FLIER;
  const packet = svgEl('circle', { class: 'packet', r: 2 });
  g.append(flier, packet);
  islBirds.append(g);
  islBird = { g, flier, packet };
  return islBird;
}

const islSleep = ms => new Promise(r => window.setTimeout(r, ms));

function islFly(fromX, toX, ms) {
  return new Promise((resolve) => {
    const started = performance.now();
    const step = (now) => {
      const t = Math.max(0, Math.min(1, (now - started) / ms));
      const k = glideProgress(t);
      const x = fromX + (toX - fromX) * k;
      const y = 21 - Math.sin(k * Math.PI) * 4;
      const flip = toX < fromX ? -1 : 1;
      islBird.g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${flip * 0.4} 0.4)`);
      if (t < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

function islWait(predicate) {
  return new Promise((r) => {
    const timer = window.setInterval(() => {
      if (predicate()) { window.clearInterval(timer); r(); }
    }, 250);
  });
}

function islPerch() {
  islBird.g.classList.add('perched');
  islBird.g.setAttribute('transform', 'translate(34 3) scale(0.4)');
}

// The island's own courier: it lives on the left brand chip, flies empty to
// the vendor when a request starts, tucks in, and rides home with the golden
// answer once magpie is done.
async function islandBirdLoop() {
  const bird = ensureIslandBird();
  islPerch();
  for (;;) {
    await islSleep(400);
    if (!document.body.classList.contains('docked')
      || document.body.classList.contains('expanded')) continue;
    const active = [...state.routes.values()].filter(requestActive);
    if (!active.length) { islPerch(); continue; }
    const route = active.at(-1);
    const id = String(route.id);
    const group = state.groups.get(groupKeyOf(route));
    const accent = group ? accentOf(group) : '#a18bff';
    bird.g.style.setProperty('--agent', accent);
    bird.g.classList.remove('perched');
    bird.flier.style.opacity = '1';
    await islFly(38, 192, 1100);
    // tucked into the vendor chip: the request glows there while waiting
    bird.flier.style.opacity = '0';
    islPacket.style.setProperty('--c', accent);
    islPacket.setAttribute('transform', 'translate(196 21)');
    islPacket.style.opacity = '1';
    await islWait(() => {
      const fresh = state.routes.get(id);
      return !fresh || fresh.done;
    });
    // ride home with the golden answer
    islPacket.style.opacity = '0';
    bird.g.classList.add('back');
    bird.flier.style.opacity = '1';
    await islFly(192, 38, 1500);
    bird.g.classList.remove('back');
    islPerch();
  }
}

function updateIsland() {
  if (!islLights) return;
  islLights.innerHTML = '';
  const groups = [...state.groups.values()];
  const active = groups.filter(g => g.routes.some(id => requestActive(state.routes.get(String(id)))));
  const first = groups[0];
  const accent = first ? accentOf(first) : '#a18bff';
  const islandEl = document.getElementById('island');
  islandEl.classList.toggle('flow', active.length > 0);
  islandEl.style.setProperty('--c', accent);
  // The island's two ends wear the brand icons of the agent and the vendor
  // it is talking to; plain dots only when no brand matches.
  if (first) {
    const route = latestRouteOf(first) || {};
    const seat = route.order?.[0] || {};
    const agentKey = brandKeyOf(first.agent, 'agent');
    const vendorKey = brandKeyOf(seat.icon, 'provider')
      || brandKeyOf(seat.provider || route.provider, 'provider');
    setIslandEnd(islLeft, agentKey, accent);
    setIslandEnd(islRight, vendorKey, accent);
  }
  // Comets: a bright head with a small trailing tail, one per active request.
  for (const [i, group] of active.entries()) {
    const comet = svgEl('g', { class: 'isl-light' });
    comet.style.setProperty('--c', accentOf(group));
    comet.style.animationDelay = `${(-(i * 0.8)).toFixed(2)}s`;
    comet.style.animationDuration = `${(2.2 + i * 0.4).toFixed(2)}s`;
    comet.append(
      svgEl('circle', { cx: 38, cy: 21, r: 2.2 }),
      svgEl('circle', { class: 'tail', cx: 33, cy: 21, r: 1.1 }),
    );
    islLights.append(comet);
    if (i >= 2) break;
  }
  const text = islText;
  text.textContent = active.length
    ? `${active.length} 个请求`
    : `${fmtTokens(usageTotal(state.usage))} tok`;
}

function setIslandEnd(anchor, key, accent) {
  anchor.innerHTML = '';
  anchor.style.setProperty('--c', accent);
  anchor.append(svgEl('circle', { class: 'isl-chip', cx: 0, cy: 0, r: 10.5 }));
  const icon = brandMark(key, -7.5, -7.5, 15);
  if (icon) anchor.append(icon);
  else anchor.append(svgEl('circle', { class: 'isl-fallback', cx: 0, cy: 0, r: 3.5 }));
}

function wire(d, accent, kind, lit) {
  const p = svgEl('path', { class: `wire ${kind}${lit ? '' : ' resting'}`, d });
  p.style.setProperty('--c', accent);
  return p;
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

// Resolves true when the leg completed, false when the flight was cancelled
// or lost its geometry — the playback loop stops only on a false.
function flyTo(flight, spec, ms) {
  return new Promise((resolve) => {
    const started = performance.now();
    let crossed = false;
    const step = (now) => {
      if (flight.cancelled) { resolve(false); return; }
      if (!buildLegs(flight, spec)) { resolve(false); return; }
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
      else resolve(true);
    };
    requestAnimationFrame(step);
  });
}

function setPose(flight, pose) {
  const held = pose.includes('hold');
  flight.bird.classList.toggle('back', pose.includes('back'));
  flight.bird.classList.toggle('failed', pose.includes('failed'));
  flight.bird.classList.toggle('held', held);
  if (!held && flight.holePacket) {
    flight.holePacket.remove();
    flight.holePacket = null;
  }
}

// The data sits in the burrow glowing; the courier perches at the mouth and
// waits where it can be seen.
function placeHolePacket(flight, x, y) {
  if (!flight.holePacket) {
    flight.holePacket = svgEl('circle', { class: 'hole-packet', r: 3, cx: 0, cy: 0 });
    flight.holePacket.style.setProperty('--c', flight.accent);
    fx.append(flight.holePacket);
  }
  flight.holePacket.setAttribute('transform', `translate(${x} ${y})`);
}

function holdAt(flight, where) {
  setPose(flight, `hold-${where}`);
  const y = laneY(flight.lane);
  if (where === 'hub') {
    flight.bird.setAttribute('transform', `translate(${HUB.left + 9} ${HUB.y - 24}) scale(0.72)`);
    placeHolePacket(flight, HUB.left + 2, HUB.y);
  } else {
    flight.bird.setAttribute('transform', `translate(${ACCOUNT_X + 7} ${y - 7}) scale(0.72)`);
    placeHolePacket(flight, ACCOUNT_X, y);
  }
}

const LEGS_TO_HUB = [{ path: 'in' }];
const LEGS_TO_ACCOUNT = [{ path: 'through' }, { path: 'out' }];
const LEGS_RETURN = [{ path: 'out', reverse: true }, { path: 'through', reverse: true }, { path: 'in', reverse: true }];
const LEGS_BACK_TO_HUB = [{ path: 'out', reverse: true }];
const LEGS_HUB_HOME = [{ path: 'in', reverse: true }];

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
  flight.holePacket?.remove();
  flight.holePacket = null;
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
    accent: color, holePacket: null, merged: Boolean(group?.merged),
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
      // Same agent and account: one wire, one burrow — the answer simply
      // comes back the way the request went in.
      if (flight.merged) {
        await waitFor(flight, r => Boolean((r.tries || [])[index]?.done));
        if (flight.cancelled) return;
        const mergedAttempt = flight.route.tries[index];
        if (succeeded(mergedAttempt)) {
          await waitFor(flight, r => r.done);
          if (flight.cancelled) return;
          setPose(flight, 'back');
          if (!await travel(flight, LEGS_HUB_HOME)) return;
          fadeOut(flight);
          return;
        }
        const mergedNext = (flight.route.tries || []).length > index + 1;
        if (!mergedNext && flight.route.done) {
          setPose(flight, 'back failed');
          if (!await travel(flight, LEGS_HUB_HOME)) return;
          fadeOut(flight);
          return;
        }
        setPose(flight, 'fly failed');
        holdAt(flight, 'hub');
        index += 1;
        await waitFor(flight, r => Boolean((r.tries || [])[index]));
        continue;
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
  state.opacity = Math.min(1, Math.max(0.05, Number(value) || 0.34));
  refreshSurface();
}

// The docked island idles as a transparent window; the card surface only
// paints when it drops down.
function refreshSurface() {
  const dockedIdle = document.body.classList.contains('docked')
    && !document.body.classList.contains('expanded');
  if (dockedIdle) {
    document.body.style.background = 'transparent';
    return;
  }
  const alpha = state.opacity ?? 0.34;
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
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panel.classList.contains('open')) togglePanel(false);
});
// Clicking anywhere outside the panel closes it, so it can never trap the card.
document.addEventListener('mousedown', (event) => {
  if (panel.classList.contains('open')
    && !event.target.closest('.panel')
    && !event.target.closest('.gear')) {
    togglePanel(false);
  }
});

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
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    window.bird?.resizeStart(band.dataset.dir);
  });
}

window.addEventListener('mouseup', () => {
  window.bird?.dragEnd();
  window.bird?.resizeEnd();
});

// Esc is the emergency brake for drags and resizes gone wrong.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.bird?.resizeEnd();
    window.bird?.dragEnd();
  }
});

// Dragging the island itself undocks it from the screen top.
island.addEventListener('mousedown', (event) => {
  event.preventDefault();
  window.bird?.dragStart();
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
  document.body.classList.toggle('docked', Boolean(settings.docked));
  refreshSurface();
  applyTheme(settings.themeColor);
  renderPill();
  if (panel.classList.contains('open')) syncPanel();
});
window.bird?.onExpand((expanded) => {
  document.body.classList.toggle('expanded', Boolean(expanded));
  refreshSurface();
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
islandBirdLoop();
window.bird?.ready();
