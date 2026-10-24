#!/usr/bin/env node
// Evaluate a JavaScript expression in the widget's renderer over the DevTools
// protocol, for automated checks:
//
//   electron . --remote-debugging-port=9223 &
//   node tools/cdp-eval.mjs "document.body.className"

'use strict';

const port = process.argv[2] || '9223';
const expression = process.argv[3] || 'document.title';

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
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    }));
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  ws.close();
  console.log(JSON.stringify(result.result?.value, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
