#!/usr/bin/env node
// A local stand-in for magpie's gateway: serves /v1/magpie/trace and
// /v1/magpie/usage with simulated traffic so the widget can be developed
// without live requests.
//
//   node tools/mock-server.mjs [port]        # default 3529
//   BUSY_BIRD_GATEWAY=http://127.0.0.1:3529 npm start

import http from 'node:http';

const port = Number(process.argv[2]) || 3529;

const AGENTS = ['dsh', 'Codex', 'Claude Code', 'Qoder'];
const ACCOUNTS = ['workbuddy-ai/step-5', 'zen-free/deepseek-v4.1', 'team/gpt-5.2', 'anthropic/claude-v4'];

let seq = 1;
let nextId = 1792862888000;
const routes = new Map();

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

function spawnRequest() {
  const id = nextId++;
  const agent = pick(AGENTS);
  const accountId = agent === 'dsh' ? 'dsh/self-model' : pick(ACCOUNTS);
  const route = {
    seq: seq++,
    id,
    time: new Date().toISOString(),
    agent,
    provider: 'mock',
    model: 'mock/deepseek-v4.1-flash',
    order: [{ id: accountId, provider: 'mock', name: 'Mock', who: 'mock', kind: 'account', plan: 'Free' }],
    tries: [],
    done: false,
  };
  routes.set(String(id), route);

  setTimeout(() => {
    route.tries.push({ id: accountId, model: route.model, start: new Date().toISOString(), done: false });
    setTimeout(() => {
      const attempt = route.tries[0];
      if (Math.random() < 0.18) {
        attempt.done = true; attempt.status = 500; attempt.fail = true;
        setTimeout(() => {
          route.tries.push({ id: accountId, model: route.model, start: new Date().toISOString(), done: true, status: 200, ms: 2100 });
          route.done = true; route.status = 200;
        }, 1600);
      } else {
        attempt.done = true; attempt.status = 200; attempt.ms = 1500 + Math.floor(Math.random() * 4000);
        route.done = true; route.status = 200;
      }
      prune();
    }, 2500 + Math.random() * 3500);
  }, 600 + Math.random() * 700);
}

function prune() {
  const now = Date.now();
  for (const [id, route] of routes) {
    if (route.done && now - new Date(route.time).getTime() > 60000) routes.delete(id);
  }
}

function snapshot(after) {
  const all = [...routes.values()];
  return {
    seq,
    now: new Date().toISOString(),
    object: 'trace',
    pid: process.pid,
    routes: after ? all.filter(route => route.seq > Number(after)) : all,
  };
}

let usageIn = 4821000;
let usageOut = 233400;

setInterval(() => {
  usageIn += Math.floor(Math.random() * 40000);
  usageOut += Math.floor(Math.random() * 4000);
}, 3000);

setInterval(spawnRequest, 3200 + Math.random() * 2600);
spawnRequest();

const waiters = new Set();

setInterval(() => {
  for (const respond of [...waiters]) {
    waiters.delete(respond);
    respond();
  }
}, 1200);

http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/v1/magpie/trace') {
    const after = Number(url.searchParams.get('after')) || 0;
    const wait = url.searchParams.get('wait') === '1';
    const reply = () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(snapshot(after)));
    };
    if (wait && snapshot(after).routes.length === 0) {
      const timer = setTimeout(() => { waiters.delete(reply); reply(); }, 25000);
      waiters.add(() => { clearTimeout(timer); reply(); });
    } else {
      reply();
    }
    return;
  }
  if (url.pathname === '/v1/magpie/usage') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      period: url.searchParams.get('period') || 'today',
      since: new Date(Date.now() - 86400000).toISOString(),
      calls: 128, errors: 2, retried: 3,
      input: usageIn, output: usageOut, cache_read: 18200000, cache_write: 0,
      reasoning: 120000, cost: 1.42, unpriced: 0,
    }));
    return;
  }
  response.writeHead(404);
  response.end('not found');
}).listen(port, '127.0.0.1', () => {
  console.log(`[mock] magpie simulator on http://127.0.0.1:${port}`);
  console.log('[mock] start the widget with:');
  console.log(`[mock]   BUSY_BIRD_GATEWAY=http://127.0.0.1:${port} npm start`);
});
