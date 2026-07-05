// Real-browser verification of the "today's move" green/red ticket:
//   • watchlist day-move (.watch-today) and holdings day-move (.holding-day)
//     are now solid filled boxes (gradient background + colored glow)
//   • the numerals inside are white in both lists
//   • green for an up day, red for a down day
// Run: node backend/test/verify-day-move-box.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS = join(ROOT, 'test-screenshots');
const PORT = 9922;
const DBG = 9232;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SEED = {
  'pb.watchlist.v2': [
    { id: 'w1', ticker: 'GOOGL', market: 'US', name: 'Alphabet Inc.' },
    { id: 'w2', ticker: 'AAPL', market: 'US', name: 'Apple Inc.' },
    { id: 'w3', ticker: 'TSLA', market: 'US', name: 'Tesla Inc.' },
  ],
  'pb.positions.v2': [
    { id: 'p1', ticker: 'AAPL', market: 'US', shares: 12, costBasis: 150, name: 'Apple Inc.', purchaseDate: '2024-02-01', buyFx: 1 },
    { id: 'p2', ticker: 'GOOGL', market: 'US', shares: 5, costBasis: 120.5, name: 'Alphabet Inc. Class A', purchaseDate: '2024-03-01', buyFx: 1 },
  ],
  'pb.prices.v1': {
    // GOOGL up (green), AAPL down (red), TSLA up (green) — covers both colors.
    'US:GOOGL': { price: 368.03, change: 4.24, changePct: 1.17, prevClose: 363.79, yearHigh: 408.5, currency: 'USD', fetchedAt: Date.now() },
    'US:AAPL': { price: 232.1, change: -1.8, changePct: -0.77, prevClose: 233.9, yearHigh: 260.1, currency: 'USD', fetchedAt: Date.now() },
    'US:TSLA': { price: 412.0, change: 6.0, changePct: 1.48, prevClose: 406.0, yearHigh: 414.0, currency: 'USD', fetchedAt: Date.now() },
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
  const realFetch = window.fetch;
  window.fetch = (u, o) => { const s = String(u || ''); if (s.startsWith('http')) return Promise.reject(new Error('offline-verify')); return realFetch(u, o); };
</script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="/pb-core.js"></script>
<script src="/pb-data.js"></script>
<script src="/pb-store.js"></script>
<script src="/pb-content.js"></script>
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
  writeFileSync(join(SHOTS, `daymove-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot daymove-${name}.png`);
}

const isWhite = (c) => /rgba?\(\s*255,\s*255,\s*255/.test(c || '');
const hasFill = (bgImg, bgColor) => (bgImg && bgImg !== 'none') || (bgColor && !/rgba?\([^)]*,\s*0\)/.test(bgColor) && bgColor !== 'transparent');

let chrome, userDir, failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failures++; };
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-daymove-'));
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
  await sleep(700);

  // ---- WATCHLIST ----
  await evals(ws, `const b=document.querySelector('[data-tab="watchlist"]'); if(b) b.click(); return true;`);
  await sleep(700);
  await shot(ws, 'watchlist');
  const wl = JSON.parse(await evals(ws, `
    const out = [];
    for (const el of document.querySelectorAll('.watch-today.up, .watch-today.down')) {
      const cs = getComputedStyle(el);
      const pct = el.querySelector('.watch-today-pct');
      const pcs = pct ? getComputedStyle(pct) : null;
      const r = el.getBoundingClientRect();
      out.push({
        dir: el.classList.contains('up') ? 'up' : 'down',
        bgImage: cs.backgroundImage, bgColor: cs.backgroundColor,
        radius: cs.borderTopLeftRadius, shadow: cs.boxShadow !== 'none',
        textColor: pcs ? pcs.color : null,
        boxed: r.height > 18 && r.width > 36,
        text: pct ? pct.textContent.trim() : null,
      });
    }
    return JSON.stringify(out);
  `));
  console.log('  watchlist day-move boxes:', wl.length);
  for (const b of wl) console.log('   ', JSON.stringify(b));
  ok('watchlist: found day-move boxes', wl.length >= 2);
  ok('watchlist: every box has a filled green/red background', wl.length > 0 && wl.every(b => hasFill(b.bgImage, b.bgColor)));
  ok('watchlist: every box has rounded corners', wl.every(b => parseFloat(b.radius) >= 4));
  ok('watchlist: numerals are white', wl.length > 0 && wl.every(b => isWhite(b.textColor)), wl.map(b => b.textColor).join(' / '));
  ok('watchlist: box reads as a box (size)', wl.every(b => b.boxed));
  ok('watchlist: covers both up (green) and down (red)', wl.some(b => b.dir === 'up') && wl.some(b => b.dir === 'down'));

  // ---- HOLDINGS ----
  await evals(ws, `const b=document.querySelector('[data-tab="current"]'); if(b) b.click(); return true;`);
  await sleep(700);
  await shot(ws, 'holdings');
  const hd = JSON.parse(await evals(ws, `
    const out = [];
    for (const el of document.querySelectorAll('.holding-day')) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out.push({
        dir: el.classList.contains('text-up') ? 'up' : (el.classList.contains('text-down') ? 'down' : '?'),
        bgImage: cs.backgroundImage, bgColor: cs.backgroundColor,
        radius: cs.borderTopLeftRadius, shadow: cs.boxShadow !== 'none',
        textColor: cs.color,
        boxed: r.height > 14 && r.width > 32,
        text: el.textContent.trim(),
      });
    }
    return JSON.stringify(out);
  `));
  console.log('  holdings day-move boxes:', hd.length);
  for (const b of hd) console.log('   ', JSON.stringify(b));
  ok('holdings: found day-move boxes', hd.length >= 1);
  ok('holdings: every box has a filled green/red background', hd.length > 0 && hd.every(b => hasFill(b.bgImage, b.bgColor)));
  ok('holdings: every box has rounded corners', hd.every(b => parseFloat(b.radius) >= 4));
  ok('holdings: numerals are white', hd.length > 0 && hd.every(b => isWhite(b.textColor)), hd.map(b => b.textColor).join(' / '));
  ok('holdings: box reads as a box (size)', hd.every(b => b.boxed));
  ok('holdings: covers both up (green) and down (red)', hd.some(b => b.dir === 'up') && hd.some(b => b.dir === 'down'));

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) {
  console.error('ERROR', e); failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
