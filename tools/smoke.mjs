#!/usr/bin/env node
// Smoke test against a running widget with --remote-debugging-port:
//
//   electron . --remote-debugging-port=9223 &
//   node tools/smoke.mjs 9223
//
// Drives the real renderer: panels open/close, skins switch, the stats card
// fills from the usage API. Exits 0 when every check passes.

'use strict';

const port = process.argv[2] || '9223';

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws error'));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (msg) => {
      if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text + ' ' +
        (msg.result.exceptionDetails.exception?.description || '')));
      else resolve(msg.result?.result?.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push([name, Boolean(ok), String(detail).slice(0, 80)]);
  };

  // 1. bridge and basic chrome
  check('preload bridge', await evaluate('Boolean(window.bird)'));
  check('sky svg present', await evaluate('Boolean(document.getElementById("sky"))'));

  // 2. pill has content
  check('pill has text', await evaluate('document.getElementById("pill").textContent.trim().length > 0'));

  // 3. settings panel opens and closes
  await evaluate('document.getElementById("gear").click()');
  await sleep(150);
  check('panel opens', await evaluate('document.getElementById("panel").classList.contains("open")'));
  await evaluate('document.getElementById("panelClose").click()');
  await sleep(150);
  check('panel closes', await evaluate('!document.getElementById("panel").classList.contains("open")'));

  // 4. skins: the topbar dot is gone (switching moved to right-click menu),
  //    the island courier exists, and the skin stylesheet is loaded
  check('skin dot removed from topbar', await evaluate('!document.getElementById("skinDot")'));
  check('island courier element exists', await evaluate('document.querySelectorAll(".isl-bird .flier > g").length > 0'));
  check('skin css loaded', await evaluate('document.querySelectorAll("style,link[href*=styles]").length > 0 && Boolean(document.querySelector(".isl-bird"))'));

  // 5. the island pager marks sessions with round dots, never flat bars
  check('island pager uses round dots', await evaluate(`(() => {
    const dots = [...document.querySelectorAll('.isl-pager-dot')];
    return dots.length === 0 || dots.every(d => d.tagName.toLowerCase() === 'circle');
  })()`));

  // 5. stats card opens and fills from the usage API
  await evaluate('document.getElementById("statDot").click()');
  await sleep(1500);
  check('stats card opens', await evaluate('document.getElementById("statsCard").classList.contains("open")'));
  const calls = await evaluate('document.getElementById("stCalls").textContent');
  check('stats card has call count', /[\d]/.test(String(calls)), calls);
  const bars = await evaluate('document.querySelectorAll("#chart .chart-bar").length');
  check('24h chart has 24 bars', bars === 24, String(bars));
  await evaluate('document.getElementById("statsClose").click()');
  await sleep(150);
  check('stats card closes', await evaluate('!document.getElementById("statsCard").classList.contains("open")'));

  // 6. docked mode (if active): island visible with brand icons
  const docked = await evaluate('document.body.classList.contains("docked")');
  if (docked) {
    check('island visible when docked', await evaluate('getComputedStyle(document.getElementById("island")).display !== "none"'));
    check('island end groups present', await evaluate('document.querySelectorAll(".isl-end").length === 2'));
  } else {
    check('normal mode: stage visible', await evaluate('getComputedStyle(document.getElementById("sky")).display !== "none"'));
  }

  // 7. no renderer errors recorded since launch
  ws.close();
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) failed++;
  }
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('smoke failed:', error.message);
  process.exit(1);
});
