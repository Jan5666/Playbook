// Real-browser verification of the Settings/Alerts changes (headless Chrome via
// CDP). Serves the project, seeds localStorage with holdings + alerts before
// app.js mounts, then drives the UI and screenshots each changed surface into
// test-screenshots/verify-*.png. Run: node backend/test/verify-settings.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS = join(ROOT, 'test-screenshots');
const PORT = 9917;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

// Seed: 4 holdings across 2 markets + 2 active alerts + 2 triggered + keys.
const SEED = {
  'pb.positions.v2': [
    { id: 'p1', ticker: 'AAPL', market: 'US', shares: 12, costBasis: 150, name: 'Apple Inc.', purchaseDate: '2024-02-01', buyFx: 1 },
    { id: 'p2', ticker: 'MSFT', market: 'US', shares: 5, costBasis: 300, name: 'Microsoft Corporation', purchaseDate: '2024-03-01', buyFx: 1 },
    { id: 'p3', ticker: 'STX40', market: 'JSE', shares: 40, costBasis: 80, name: 'Satrix 40 ETF', purchaseDate: '2024-01-15', buyFx: 18 },
    { id: 'p4', ticker: 'NPN', market: 'JSE', shares: 3, costBasis: 3100, name: 'Naspers Limited', purchaseDate: '2024-04-01', buyFx: 18 },
  ],
  'pb.alerts.v2': [
    { id: 'a1', ticker: 'AAPL', market: 'US', direction: 'above', targetPrice: 200, note: 'breakout watch' },
    { id: 'a2', ticker: 'NPN', market: 'JSE', direction: 'below', targetPrice: 2800 },
  ],
  // Many entries so the notifications menu overflows and we can prove it scrolls.
  'pb.triggered.v2': [
    { id: 't1', ticker: 'MSFT', market: 'US', direction: 'above', targetPrice: 320, triggerPrice: 322.5, triggeredAt: new Date(Date.now() - 3600e3).toISOString() },
    { id: 't2', ticker: 'STX40', market: 'JSE', direction: 'below', targetPrice: 85, triggerPrice: 84.2, triggeredAt: new Date(Date.now() - 7200e3).toISOString() },
    ...Array.from({ length: 12 }, (_, i) => ({ id: 'tx' + i, ticker: ['AAPL', 'MSFT', 'NPN', 'STX40'][i % 4], market: i % 2 ? 'US' : 'JSE', direction: i % 2 ? 'above' : 'below', targetPrice: 100 + i, triggerPrice: 99 + i, triggeredAt: new Date(Date.now() - (i + 3) * 3600e3).toISOString() })),
  ],
  'pb.perplexityKey.v1': 'pplx-demo-key-1234567890',
  'pb.prices.v1': {
    'US:AAPL': { price: 190, change: 1.2, changePct: 0.63, prevClose: 188.8, currency: 'USD', fetchedAt: Date.now() },
    'US:MSFT': { price: 322, change: 2.5, changePct: 0.78, prevClose: 319.5, currency: 'USD', fetchedAt: Date.now() },
    'JSE:STX40': { price: 84, change: -0.5, changePct: -0.59, prevClose: 84.5, currency: 'ZAR', fetchedAt: Date.now() },
    'JSE:NPN': { price: 3150, change: 20, changePct: 0.64, prevClose: 3130, currency: 'ZAR', fetchedAt: Date.now() },
  },
};

const seedJson = JSON.stringify(SEED).replace(/</g, '\\u003c');
const VERIFY_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="/styles.css">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
</head><body>
<div id="root"></div>
<script>
  try { const s = ${seedJson}; for (const k in s) localStorage.setItem(k, JSON.stringify(s[k])); } catch(e){}
  // Keep the app from hanging on live network during the screenshot run.
  const realFetch = window.fetch;
  window.fetch = (u, o) => { const s = String(u || ''); if (s.startsWith('http')) return Promise.reject(new Error('offline-verify')); return realFetch(u, o); };
</script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="/pb-core.js"></script>
<script src="/pb-data.js"></script>
<script src="/pb-store.js"></script>
<script src="/pb-content.js"></script>
<script src="/pb-import.js"></script>
<script src="/pb-view-hot.js"></script>
<script src="/data.js"></script>
<script src="/app.js"></script>
</body></html>`;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/__verify.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(VERIFY_HTML); }
  if (p === '/sw.js') { res.writeHead(404); return res.end('no sw'); }
  const f = normalize(join(ROOT, p));
  if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[f.slice(f.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream' });
  res.end(readFileSync(f));
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function cdp(ws, method, params = {}, id = Math.floor(Math.random() * 1e9)) {
  return new Promise((resolve, reject) => {
    const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
    ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evals(ws, expr, timeout = 20000) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
}
async function shot(ws, name) {
  const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOTS, `verify-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  📸 verify-${name}.png`);
}

let chrome, userDir, failures = 0;
const ok = (l, c, d) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); } };

try {
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-verify-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=440,900', '--force-device-scale-factor=2',
    '--remote-debugging-port=9227', `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch('http://localhost:9227/json')).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 440, height: 900, deviceScaleFactor: 2, mobile: true });

  const mounted = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  ok('app mounted', mounted);
  await sleep(700);

  // ── Open Settings ──
  await evals(ws, `document.querySelector('[aria-label="Settings"]').click(); return true;`);
  await sleep(500);
  const navLabels = await evals(ws, `return [...document.querySelectorAll('.settings-nav-item')].map(b=>b.textContent.trim());`);
  console.log('  nav:', JSON.stringify(navLabels));
  ok('Display renamed to "Currency"', navLabels.includes('Currency'), JSON.stringify(navLabels));
  ok('"Display" tab gone', !navLabels.includes('Display'));
  ok('"Connections" tab added', navLabels.includes('Connections'));
  await shot(ws, 'settings-currency');

  // ── Tabs section: drag handles present ──
  await evals(ws, `[...document.querySelectorAll('.settings-nav-item')].find(b=>b.textContent.includes('Tabs')).click(); return true;`);
  await sleep(400);
  const grips = await evals(ws, `return document.querySelectorAll('.tab-config-grip').length;`);
  ok('Tabs: drag handles render', grips > 0, 'grips=' + grips);
  ok('Tabs: old arrow reorder removed', (await evals(ws, `return document.querySelectorAll('.tab-config-reorder').length;`)) === 0);
  await shot(ws, 'settings-tabs');

  // Simulate a drag: move the 2nd row up via synthesized pointer events on its grip.
  const dragResult = await evals(ws, `
    const rows=[...document.querySelectorAll('.tab-config-row')];
    const before=rows.map(r=>r.querySelector('.tab-config-name').textContent);
    const grip=rows[2].querySelector('.tab-config-grip');
    const rb=rows[2].getBoundingClientRect(), tb=rows[0].getBoundingClientRect();
    const fire=(t,y)=>grip.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,clientX:rb.left+10,clientY:y,pointerId:1,button:0}));
    fire('pointerdown', rb.top+15);
    for(let y=rb.top+15;y>=tb.top;y-=8){ fire('pointermove', y); }
    fire('pointermove', tb.top-4); fire('pointerup', tb.top-4);
    await new Promise(r=>setTimeout(r,350));
    const after=[...document.querySelectorAll('.tab-config-row')].map(r=>r.querySelector('.tab-config-name').textContent);
    return JSON.stringify({before, after, changed: JSON.stringify(before)!==JSON.stringify(after)});
  `);
  const dr = JSON.parse(dragResult);
  console.log('  drag before:', JSON.stringify(dr.before));
  console.log('  drag after :', JSON.stringify(dr.after));
  ok('Tabs: drag reorders the list', dr.changed, dragResult);

  // ── Holdings: premium list + 2-step confirm ──
  await evals(ws, `[...document.querySelectorAll('.settings-nav-item')].find(b=>b.textContent.includes('Holdings')).click(); return true;`);
  await sleep(400);
  ok('Holdings: premium rows render', (await evals(ws, `return document.querySelectorAll('.hm-row').length;`)) === 4);
  await shot(ws, 'settings-holdings');
  // Select two rows, arm delete, confirm panel should appear (no window.confirm).
  await evals(ws, `const r=document.querySelectorAll('.hm-row'); r[0].click(); r[2].click(); return true;`);
  await sleep(200);
  await shot(ws, 'settings-holdings-selected');
  await evals(ws, `document.querySelector('.hm-bar .btn-danger').click(); return true;`);
  await sleep(300);
  const confirmShown = await evals(ws, `return !!document.querySelector('.hm-confirm');`);
  ok('Holdings: in-dialog confirm panel appears', confirmShown);
  ok('Holdings: confirm lists selected chips', (await evals(ws, `return document.querySelectorAll('.hm-confirm-chip').length;`)) === 2);
  await shot(ws, 'settings-holdings-confirm');
  // Cancel keeps holdings intact.
  await evals(ws, `[...document.querySelectorAll('.hm-confirm-actions .btn')].find(b=>/cancel/i.test(b.textContent)).click(); return true;`);
  await sleep(200);
  ok('Holdings: Cancel returns to list (none deleted)', (await evals(ws, `return document.querySelectorAll('.hm-row').length;`)) === 4);

  // ── Connections: perplexity + push moved here ──
  await evals(ws, `[...document.querySelectorAll('.settings-nav-item')].find(b=>b.textContent.includes('Connections')).click(); return true;`);
  await sleep(400);
  const connCards = await evals(ws, `return [...document.querySelectorAll('.conn-card-title')].map(t=>t.textContent.trim());`);
  console.log('  conn cards:', JSON.stringify(connCards));
  ok('Connections: AI news card', connCards.some(t => /AI news/i.test(t)));
  ok('Connections: push server card', connCards.some(t => /push server/i.test(t)));
  await shot(ws, 'settings-connections');

  // Close settings, open Alerts.
  await evals(ws, `document.querySelector('.settings-overlay .modal-close').click(); return true;`);
  await sleep(300);
  await evals(ws, `document.querySelector('[aria-label="Alerts"]').click(); return true;`);
  await sleep(500);
  // Perplexity + push must be GONE from alerts; triggers must be tappable.
  const alertsBody = await evals(ws, `return document.querySelector('.modal-body').textContent;`);
  ok('Alerts: Perplexity removed from notifications', !/Perplexity/i.test(alertsBody), alertsBody.slice(0, 80));
  ok('Alerts: push server removed from notifications', !/push server/i.test(alertsBody));
  ok('Alerts: triggered rows are tappable', (await evals(ws, `return document.querySelectorAll('.alert-item-tap[role="button"]').length;`)) >= 2);
  await shot(ws, 'alerts-menu');

  // Scroll the notifications menu up and down — must move and settle correctly.
  const scrollTest = await evals(ws, `
    const sc = document.querySelector('.modal-panel');
    if (!sc) return JSON.stringify({ err: 'no panel' });
    const overflow = sc.scrollHeight - sc.clientHeight;
    sc.scrollTop = sc.scrollHeight; await new Promise(r=>setTimeout(r,120));
    const down = sc.scrollTop;
    sc.scrollTop = 0; await new Promise(r=>setTimeout(r,120));
    const up = sc.scrollTop;
    return JSON.stringify({ overflow, down, up });
  `);
  const st = JSON.parse(scrollTest);
  console.log('  scroll:', scrollTest);
  ok('Alerts: menu overflows and scrolls down', st.overflow > 40 && st.down > 40, scrollTest);
  ok('Alerts: menu scrolls back to top', st.up === 0, scrollTest);

  // Tap a triggered row → should open that company's stock detail chart.
  await evals(ws, `document.querySelector('.alert-item-tap').click(); return true;`);
  await sleep(900);
  const detailOpen = await evals(ws, `return { panel: !!document.querySelector('.stock-detail-panel'), alertsGone: !document.querySelector('.modal-title') || document.querySelector('.modal-title').textContent!=='Alerts' };`);
  ok('Alerts: tapping a trigger opens the stock chart', detailOpen.panel, JSON.stringify(detailOpen));
  await shot(ws, 'alerts-trigger-chart');

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failures + ' CHECK(S) FAILED'}`);
} catch (e) {
  console.error('FATAL', e);
  failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures ? 1 : 0);
}
