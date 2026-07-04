// Preview-mode DATA-SAFETY verification (headless Chrome via CDP).
// The invariant under test: while pb.previewMode.v1 is ON, the user's real
// collections can NEVER be shown as editable or overwritten — even on the
// worst-case stale PWA shell where demo-data.js is missing AND unfetchable.
//   1. Loaded portfolio, demo present: enable preview via the Settings UI →
//      demo shows; store-level writes to user collections are refused; every
//      real pb.* collection key stays byte-identical; off → real book returns.
//   2. Stale shell (no demo tag) + demo-data.js BLOCKED (offline heal): preview
//      on → real book leaves the DOM (empty, NOT real data), badge shows,
//      writes still refused, storage untouched.
//   3. Server unblocked → toggling preview off/on heals into the demo book.
// Run: node backend/test/verify-preview-safety.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const PORT = 9947;
const DBG = 9257;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// Every user-data collection key (schema in app.js configureCollections).
const USER_KEYS = ['pb.positions.v2', 'pb.watchlist.v2', 'pb.watchlistGroups.v1', 'pb.alerts.v2',
  'pb.transactions.v1', 'pb.contributions.v1', 'pb.tfsa.deposits.v1', 'pb.sectorWeights.v1'];

// Real book: KO + a watchlist + deposits — none of it appears in the demo set.
const SEED = {
  'pb.positions.v2': [
    { id: 'real1', ticker: 'KO', market: 'US', shares: 12, costBasis: 55, name: 'Coca-Cola Company', purchaseDate: '2024-02-01' },
  ],
  'pb.watchlist.v2': [
    { id: 'realw1', ticker: 'MCD', market: 'US', name: "McDonald's Corporation", listIds: ['default'], addedAt: '2025-01-01T09:00:00.000Z' },
  ],
  'pb.alerts.v2': [
    { id: 'reala1', ticker: 'KO', market: 'US', direction: 'above', targetPrice: 70, active: true },
  ],
  'pb.contributions.v1': [
    { id: 'realc1', amount: 1000, currency: 'USD', date: '2024-02-01', fxRateAtContrib: 1, fxBase: 'USD' },
  ],
  'pb.prices.v1': {
    'US:KO': { price: 62, change: 0.4, changePct: 0.65, prevClose: 61.6, currency: 'USD', fetchedAt: Date.now() },
    'US:NVDA': { price: 170, change: 2.0, changePct: 1.19, prevClose: 168.0, currency: 'USD', fetchedAt: Date.now() },
  },
};
const seedJson = JSON.stringify(SEED).replace(/</g, '\\u003c');

const page = (withDemo) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="/styles.css">
</head><body>
<div id="root"></div>
<script>
  try { const s = ${seedJson}; for (const k in s) localStorage.setItem(k, JSON.stringify(s[k])); } catch(e){}
  const realFetch = window.fetch;
  window.fetch = (u, o) => { const s = String(u || ''); if (s.startsWith('http')) return Promise.reject(new Error('offline-verify')); return realFetch(u, o); };
</script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="/pb-core.js"></script>
<script src="/pb-data.js"></script>
<script src="/pb-store.js"></script>
<script src="/data.js"></script>
${withDemo ? '<script src="/demo-data.js"></script>' : ''}
<script src="/app.js"></script>
</body></html>`;

let blockDemo = false; // toggled via /__control endpoints to simulate offline heal
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/__verify.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(true)); }
  if (p === '/__stale.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(false)); }
  if (p === '/__block-demo') { blockDemo = true; res.writeHead(200); return res.end('on'); }
  if (p === '/__unblock-demo') { blockDemo = false; res.writeHead(200); return res.end('off'); }
  if (p === '/demo-data.js' && blockDemo) { res.writeHead(404); return res.end('blocked'); }
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
const lsSnapshot = (ws) => evals(ws, `
  const keys = ${JSON.stringify(USER_KEYS)};
  const out = {}; keys.forEach(k => out[k] = localStorage.getItem(k));
  return JSON.stringify(out);
`);
async function mount(ws) {
  return evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
}
async function setPreviewViaUI(ws, on) {
  await evals(ws, `document.querySelector('[aria-label="Settings"]').click(); return true;`);
  await sleep(400);
  await evals(ws, `[...document.querySelectorAll('.settings-nav-item')].find(b=>b.textContent.includes('Preview')).click(); return true;`);
  await sleep(300);
  await evals(ws, `[...document.querySelectorAll('.seg-toggle .seg-opt')].find(b=>b.textContent==='${on ? 'On' : 'Off'}').click(); return true;`);
  await sleep(400);
  await evals(ws, `document.querySelector('.settings-overlay .modal-close').click(); return true;`);
  await sleep(400);
}
// Try to overwrite every locked collection through the store; return which ones changed.
const attemptWrites = (ws) => evals(ws, `
  const names = ['positions','watchlist','watchlistGroups','alerts','transactions','contributions','tfsaDeposits','sectorWeights'];
  const before = {}; names.forEach(n => before[n] = JSON.stringify(PBStore.getCollection(n)));
  names.forEach(n => { try { PBStore.setCollection(n, n === 'sectorWeights' ? { EVIL: 1 } : [{ id: 'evil' }]); } catch (e) {} });
  await new Promise(r => setTimeout(r, 200));
  const mutated = names.filter(n => JSON.stringify(PBStore.getCollection(n)) !== before[n]);
  return JSON.stringify(mutated);
`);

let chrome, userDir, failures = 0;
const ok = (l, c, d) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); } };

try {
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-verify-psafety-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=390,844',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // ── Scenario 1: loaded portfolio, demo present ──
  ok('app mounted', await mount(ws));
  const snap0 = await lsSnapshot(ws);
  await setPreviewViaUI(ws, true);
  await evals(ws, `document.querySelector('[data-tab="current"]').click(); return true;`);
  await sleep(500);
  let text = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('preview on: demo book shows (NVDA)', /NVDA|NVIDIA/.test(text));
  ok('preview on: real holding hidden (KO)', !/Coca-Cola/.test(text));
  ok('preview on: badge shows', await evals(ws, `return !!document.querySelector('.preview-badge');`));
  const mutated1 = JSON.parse(await attemptWrites(ws));
  ok('preview on: store refuses ALL user-collection writes', mutated1.length === 0, 'mutated: ' + JSON.stringify(mutated1));
  ok('preview on: localStorage byte-identical after write attempts', (await lsSnapshot(ws)) === snap0);
  await setPreviewViaUI(ws, false);
  await evals(ws, `document.querySelector('[data-tab="current"]').click(); return true;`);
  await sleep(500);
  text = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('preview off: real book returns (KO)', /Coca-Cola/.test(text));
  ok('preview off: demo book gone', !/NVIDIA/.test(text));
  ok('preview off: writes flow again', JSON.parse(await attemptWrites(ws)).length > 0);
  // Those writes really landed — restore the seed for scenario 2 by reloading a fresh page.

  // ── Scenario 2: stale shell + demo-data.js unfetchable (worst case) ──
  await fetch(`http://localhost:${PORT}/__block-demo`);
  await cdp(ws, 'Page.navigate', { url: `http://localhost:${PORT}/__stale.html` });
  await sleep(1200);
  ok('stale page mounted', await mount(ws));
  ok('stale: PB_DEMO absent', await evals(ws, `return typeof window.PB_DEMO === 'undefined';`));
  const snap1 = await lsSnapshot(ws);
  await setPreviewViaUI(ws, true);
  await sleep(1200); // give the self-heal time to fail (404)
  await evals(ws, `document.querySelector('[data-tab="current"]').click(); return true;`);
  await sleep(500);
  text = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('stale+offline: real book NOT shown while badge is up', !/Coca-Cola/.test(text));
  ok('stale+offline: badge shows', await evals(ws, `return !!document.querySelector('.preview-badge');`));
  ok('stale+offline: demo still absent (heal blocked)', await evals(ws, `return typeof window.PB_DEMO === 'undefined';`));
  const mutated2 = JSON.parse(await attemptWrites(ws));
  ok('stale+offline: store refuses ALL user-collection writes', mutated2.length === 0, 'mutated: ' + JSON.stringify(mutated2));
  ok('stale+offline: localStorage byte-identical', (await lsSnapshot(ws)) === snap1);

  // ── Scenario 3: connection returns → toggling preview heals into the demo ──
  await fetch(`http://localhost:${PORT}/__unblock-demo`);
  await setPreviewViaUI(ws, false);
  await setPreviewViaUI(ws, true);
  const healed = await evals(ws, `const dl=Date.now()+8000; while(Date.now()<dl){ if(window.PB_DEMO) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  ok('heal after reconnect: demo dataset loads', healed);
  await sleep(500);
  await evals(ws, `document.querySelector('[data-tab="current"]').click(); return true;`);
  await sleep(500);
  text = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('heal after reconnect: demo book shows', /NVDA|NVIDIA/.test(text));
  await setPreviewViaUI(ws, false);
  await evals(ws, `document.querySelector('[data-tab="current"]').click(); return true;`);
  await sleep(500);
  text = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('final: real book intact (KO)', /Coca-Cola/.test(text));
  ok('final: localStorage byte-identical to pre-preview state', (await lsSnapshot(ws)) === snap1);

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failures + ' CHECK(S) FAILED'}`);
} catch (e) {
  console.error('FATAL', e);
  failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures ? 1 : 0);
}
