#!/usr/bin/env node
// Capture the widget's page content over the DevTools protocol:
//
//   node tools/cdp-shot.mjs [port] [out.png]

'use strict';

import fs from 'node:fs';

const port = process.argv[2] || '9223';
const out = process.argv[3] || 'cdp-shot.png';

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws error'));
  });
  const result = await new Promise((resolve, reject) => {
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === 1) resolve(msg.result);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    setTimeout(() => reject(new Error('timeout')), 8000);
  });
  ws.close();
  fs.writeFileSync(out, Buffer.from(result.data, 'base64'));
  console.log(`saved ${out}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
