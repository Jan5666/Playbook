// Real-browser verification of the watchlist-card restyle:
//  - stock price swapped to the top-right (where the 52W high used to be)
//  - 52W-high badge swapped to the bottom-left, with the alert bell beside it
//  - the "+$ today" cash line removed from under the % change
// Run: node backend/test/verify-watchlist.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS = join(ROOT, 'test-screenshots');
const PORT = 9921;
const DBG = 9231;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SEED = {
  'pb.watchlist.v2': [
    { id: 'w1', ticker: 'GOOGL', market: 'US', name: 'Alphabet Inc.' },
    { id: 'w2', ticker: 'AAPL', market: 'US', name: 'Apple Inc.' },
    { id: 'w3', ticker: 'TSLA', market: 'US', name: 'Tesla Inc.' },
  ],
  'pb.prices.v1': {
    // price below yearHigh → red "−9.9%" badge; has alert (seeded below) for the count.
    'US:GOOGL': { price: 368.03, change: 4.24, changePct: 1.17, prevClose: 363.79, yearHigh: 408.5, currency: 'USD', fetchedAt: Date.now() },
    'US:AAPL': { price: 232.1, change: -1.8, changePct: -0.77, prevClose: 233.9, yearHigh: 260.1, currency: 'USD', fetchedAt: Date.now() },
    'US:TSLA': { price: 412.0, change: 6.0, changePct: 1.48, prevClose: 406.0, yearHigh: 414.0, currency: 'USD', fetchedAt: Date.now() },
  },
  'pb.alerts.v2': [
    { id: 'a1', ticker: 'GOOGL', market: 'US', kind: 'above', value: 400, active: true },
  ],
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
  const realFetch = window.fetch;
  window.fetch = (u, o) => { const s = String(u || ''); if (s.startsWith('http')) return Promise.reject(new Error('offline-verify')); return realFetch(u, o); };
</script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="/data.js"></script>
<script src="/app.js"></script>
</body></html>`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
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
  const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(SHOTS, `watchlist-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot watchlist-${name}.png`);
}

let chrome, userDir, failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-watch-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=440,1100', '--force-device-scale-factor=2',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 440, height: 1100, deviceScaleFactor: 2, mobile: true });

  const mounted = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  console.log('  app mounted:', mounted);
  await sleep(600);

  await evals(ws, `const b=document.querySelector('[data-tab="watchlist"]'); if(b) b.click(); return true;`);
  await sleep(700);
  await shot(ws, 'cards');

  const layout = await evals(ws, `
    const card = document.querySelector('.watchlist-list .pos-card');
    if (!card) return '(no card)';
    const head = card.querySelector('.pos-head');
    const body = card.querySelector('.watch-body');
    const price = card.querySelector('.price-block-wrap');
    const badge = card.querySelector('.ath-badge');
    const bell  = card.querySelector('.card-alert-bell');
    const pct   = card.querySelector('.watch-today-pct');
    const amt   = card.querySelector('.watch-today-amt');
    const inHead = (el) => !!el && head.contains(el);
    const inBody = (el) => !!el && body.contains(el);
    const rb = (el) => el ? el.getBoundingClientRect() : null;
    const cr = card.getBoundingClientRect();
    const out = {
      priceInHead: inHead(price),
      badgeInBody: inBody(badge),
      bellInBody:  inBody(bell),
      pctInBody:   inBody(pct),
      amtGone:     amt === null,
      badgeText:   badge ? badge.textContent.replace(/\\s+/g,' ').trim() : null,
      pctText:     pct ? pct.textContent.trim() : null,
    };
    // Geometry sanity: badge & bell on the left half, bell to the right of the badge,
    // price hugging the right side of the header, pct hugging the right of the body.
    if (badge && bell) { out.bellRightOfBadge = rb(bell).left > rb(badge).right - 1; out.badgeOnLeft = rb(badge).left - cr.left < cr.width * 0.5; }
    if (price) out.priceOnRight = rb(price).right > cr.right - cr.width * 0.45;
    if (pct) out.pctOnRight = rb(pct).right > cr.right - cr.width * 0.45;
    return JSON.stringify(out);
  `);
  console.log('  layout:', layout);
  const L = JSON.parse(layout);
  ok('price moved into header (top-right)', L.priceInHead === true);
  ok('52W badge moved into body (bottom-left)', L.badgeInBody === true);
  ok('bell in body', L.bellInBody === true);
  ok('bell sits to the right of the 52W badge', L.bellRightOfBadge === true);
  ok('52W badge on the left half', L.badgeOnLeft === true);
  ok('price hugs the right of the header', L.priceOnRight === true);
  ok('% change still in body, on the right', L.pctInBody === true && L.pctOnRight === true);
  ok('"+$ today" amount line removed', L.amtGone === true);
  ok('badge shows 52W Hi value', /52W Hi/i.test(L.badgeText || '') && /%|ATH/.test(L.badgeText || ''));

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) {
  console.error('ERROR', e); failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
