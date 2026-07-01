// Real-browser verification of Preview mode (headless Chrome via CDP): seeds a
// REAL book, flips pb.previewMode.v1 on via the store, and proves the demo book
// (window.PB_DEMO) is shown while the real localStorage stays byte-identical —
// then flips it off and proves the real book returns.
//   Run: node backend/test/verify-preview-mode.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const PORT = 9931;
const DBG = 9241;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// The REAL book: one distinctive ticker that never appears in the demo set
// (KO is not among the 16 demo instruments; AAPL/MSFT/etc. are).
const SEED = {
  'pb.positions.v2': [
    { id: 'real1', ticker: 'KO', market: 'US', shares: 12, costBasis: 55, name: 'Coca-Cola Company', purchaseDate: '2024-02-01' },
  ],
  'pb.prices.v1': {
    'US:KO': { price: 62, change: 0.4, changePct: 0.65, prevClose: 61.6, currency: 'USD', fetchedAt: Date.now() },
    'US:NVDA': { price: 170, change: 2.0, changePct: 1.19, prevClose: 168.0, currency: 'USD', fetchedAt: Date.now() },
  },
};
const seedJson = JSON.stringify(SEED).replace(/</g, '\\u003c');

const VERIFY_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
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
<script src="/demo-data.js"></script>
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

let chrome, userDir, failures = 0;
const ok = (l, c, d) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); } };

try {
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-verify-preview-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=440,900',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  for (let i = 0; i < 50; i++) { if (await evals(ws, `return !!document.querySelector('.nav')`)) break; await sleep(200); }

  const realLsBefore = await evals(ws, `return localStorage.getItem('pb.positions.v2');`);

  // 1. Real book shows before preview.
  await evals(ws, `document.querySelector('[data-tab="current"]').click(); return true;`);
  await sleep(400);
  const realText = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('real book: KO visible before preview', /Coca-Cola/.test(realText));
  ok('real book: no demo ticker before preview', !/NVIDIA/.test(realText));
  ok('no header badge before preview', await evals(ws, `return !document.querySelector('.preview-badge');`));

  // 2. Preview on → demo book + badge; real book hidden.
  await evals(ws, `PBStore.setSetting('previewMode', true); return true;`);
  await sleep(600);
  const prevText = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('preview: demo ticker (NVDA/NVIDIA) visible', /NVDA|NVIDIA/.test(prevText));
  const leak = await evals(ws, `
    const hits = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && /Coca-Cola|(^|[^A-Z])KO([^A-Z]|$)/.test(e.textContent || ''));
    return JSON.stringify(hits.slice(0, 5).map(e => (e.className || e.tagName) + ' :: ' + (e.textContent || '').slice(0, 60)));
  `);
  ok('preview: real ticker hidden', !/Coca-Cola/.test(prevText), leak);
  ok('preview: header badge shows', await evals(ws, `return !!document.querySelector('.preview-badge');`));

  // 3. Real localStorage untouched by the swap.
  const realLsAfter = await evals(ws, `return localStorage.getItem('pb.positions.v2');`);
  ok('preview: pb.positions.v2 byte-identical', realLsAfter === realLsBefore);
  ok('preview: no demo rows leaked into storage', !/demo-/.test(realLsAfter || ''));

  // 4. Preview off → real book returns instantly.
  await evals(ws, `PBStore.setSetting('previewMode', false); return true;`);
  await sleep(600);
  const backText = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('off: real book returns', /Coca-Cola/.test(backText));
  ok('off: demo book gone', !/NVIDIA/.test(backText));
  ok('off: badge gone', await evals(ws, `return !document.querySelector('.preview-badge');`));
} catch (e) {
  failures++;
  console.error('FATAL', e);
} finally {
  try { chrome?.kill(); } catch {}
  server.close();
}
console.log(failures ? `\n❌ ${failures} CHECK(S) FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
