// Real-browser verification (headless Chrome via CDP) of the chart-axis +
// hide-value + settings-rail work:
//   1. Growth chart Y labels land on round nice-number amounts.
//   2. Growth chart X labels read like "7 Apr" / "1 May" / month names.
//   3. Hide-value blurs the big dashboard total (the CSS-specificity fix).
//   4. Settings rail renders grouped clusters with colored icon tiles (desktop).
//   5. Preview self-heal: with NO demo-data.js script tag in the page (stale
//      index.html simulation), toggling Preview on still swaps in the demo book.
// Run: node backend/test/verify-chart-axes.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS = join(ROOT, 'test-screenshots');
const PORT = 9941;
const DBG = 9251;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const SEED = {
  // KO/PEP: distinctive real-book tickers that never appear in the demo set
  // (AAPL/MSFT etc. ARE demo holdings, so they can't prove the swap happened).
  'pb.positions.v2': [
    { id: 'p1', ticker: 'KO', market: 'US', shares: 40, costBasis: 55, name: 'Coca-Cola Company', purchaseDate: '2025-03-01', buyFx: 1 },
    { id: 'p2', ticker: 'PEP', market: 'US', shares: 10, costBasis: 165, name: 'PepsiCo, Inc.', purchaseDate: '2025-04-15', buyFx: 1 },
  ],
  'pb.contributions.v1': [
    { id: 'c1', amount: 2500, currency: 'USD', date: '2025-03-01', fxRateAtContrib: 1, fxBase: 'USD' },
    { id: 'c2', amount: 1500, currency: 'USD', date: '2025-09-01', fxRateAtContrib: 1, fxBase: 'USD' },
  ],
  'pb.prices.v1': {
    'US:KO': { price: 68, change: 0.4, changePct: 0.59, prevClose: 67.6, currency: 'USD', fetchedAt: Date.now() },
    'US:PEP': { price: 178, change: 1.1, changePct: 0.62, prevClose: 176.9, currency: 'USD', fetchedAt: Date.now() },
  },
};
const seedJson = JSON.stringify(SEED).replace(/</g, '\\u003c');

// ~16 months of deterministic daily history so every chart range has real data.
const HISTORY_STUB = `
  (function () {
    function series(start, drift) {
      const pts = [];
      const from = new Date('2025-03-01T00:00:00Z').getTime();
      const today = Date.now();
      let p = start, i = 0;
      for (let t = from; t <= today; t += 864e5, i++) {
        p = Math.max(1, p * (1 + drift + 0.02 * Math.sin(i / 9)));
        pts.push({ t, p: +p.toFixed(2) });
      }
      return pts;
    }
    const H = { 'US:KO': series(55, 0.0008), 'US:PEP': series(165, 0.001) };
    PBData.fetchHistory = (ticker, market) => Promise.resolve({ points: H[market + ':' + ticker] || [] });
  })();
`;

// withDemo=false simulates the stale index.html that predates demo-data.js.
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
<script>${HISTORY_STUB}</script>
<script src="/pb-store.js"></script>
<script src="/pb-content.js"></script>
<script src="/pb-import.js"></script>
<script src="/pb-view-hot.js"></script>
<script src="/data.js"></script>
${withDemo ? '<script src="/demo-data.js"></script>' : ''}
<script src="/app.js"></script>
</body></html>`;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/__verify.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(true)); }
  if (p === '/__stale.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(false)); }
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
  userDir = mkdtempSync(join(tmpdir(), 'pb-verify-axes-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=1280,860', '--force-device-scale-factor=2',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });

  const mounted = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  ok('app mounted', mounted);
  // Wait for the growth chart line to paint (history stub resolves async).
  const chartUp = await evals(ws, `const dl=Date.now()+10000; while(Date.now()<dl){ if(document.querySelector('.chart-line-svg path')) return true; await new Promise(r=>setTimeout(r,150)); } return false;`);
  ok('growth chart painted', chartUp);
  // Let the boot splash overlay clear so screenshots show the app, not the loader.
  await evals(ws, `const dl=Date.now()+15000; while(Date.now()<dl){ if(!document.querySelector('.pb-loader')) return true; await new Promise(r=>setTimeout(r,200)); } return false;`);
  await sleep(500);

  // ── 1+2. Axis labels, default 1Y range ──
  const axis1y = JSON.parse(await evals(ws, `
    const texts = [...document.querySelectorAll('.chart-line-svg text')].map(t => t.textContent.trim());
    return JSON.stringify(texts);
  `));
  console.log('  1Y labels:', JSON.stringify(axis1y));
  const yLabs = axis1y.filter(t => /^\$/.test(t));
  const xLabs = axis1y.filter(t => /^([0-9]{1,2} )?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)( ’\d\d)?$|^\d{4}$/.test(t));
  ok('Y labels present', yLabs.length >= 3, JSON.stringify(yLabs));
  // Round = the numeric part ends in 0/5 or is a short round decimal (e.g. 2.5k).
  const roundish = v => /^\$([0-9]{1,3}(,[0-9]{3})*|[0-9]+(\.[0-9])?[kM])$/.test(v) && /(^\$[0-9]+(\.5)?[kM]$)|(^\$[0-9,]*[05](,[0-9]{3})*$)|(0[kM]?$)|(5[kM]?$)/.test(v.replace(/,/g, ''));
  ok('Y labels are round amounts', yLabs.every(roundish), JSON.stringify(yLabs.filter(v => !roundish(v))));
  ok('X labels read as dates ("7 Apr" / "Apr" / year)', xLabs.length >= 3, JSON.stringify(axis1y));
  ok('no raw MM-DD labels remain', !axis1y.some(t => /^\d\d-\d\d$/.test(t)), JSON.stringify(axis1y));
  await shot(ws, 'chart-axes-1y');

  // ── 3M range ──
  await evals(ws, `[...document.querySelectorAll('.chart-range-btn')].find(b=>b.textContent==='3M').click(); return true;`);
  await sleep(600);
  const axis3m = JSON.parse(await evals(ws, `return JSON.stringify([...document.querySelectorAll('.chart-line-svg text')].map(t=>t.textContent.trim()));`));
  console.log('  3M labels:', JSON.stringify(axis3m));
  ok('3M shows day-month ticks', axis3m.some(t => /^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(t)), JSON.stringify(axis3m));
  await shot(ws, 'chart-axes-3m');

  // ── 3. Hide-value blurs the big total ──
  await evals(ws, `[...document.querySelectorAll('.chart-range-btn')].find(b=>b.textContent==='1Y').click(); return true;`);
  await sleep(300);
  const blurBefore = await evals(ws, `return getComputedStyle(document.querySelector('.total-portfolio-card .stat-value')).filter;`);
  await evals(ws, `document.querySelector('.total-portfolio-card .icon-btn').click(); return true;`);
  await sleep(500);
  const blurAfter = await evals(ws, `return getComputedStyle(document.querySelector('.total-portfolio-card .stat-value')).filter;`);
  console.log('  stat-value filter before/after:', blurBefore, '/', blurAfter);
  ok('total not blurred while visible', blurBefore === 'blur(0px)' || blurBefore === 'none', blurBefore);
  ok('total blurred when hidden', /blur\((1[0-9]|[1-9])px\)/.test(blurAfter) && blurAfter !== 'blur(0px)', blurAfter);
  const chartMasked = await evals(ws, `return [...document.querySelectorAll('.chart-line-svg text')].some(t => t.textContent.includes('••'));`);
  ok('chart money labels mask while hidden', chartMasked);
  await shot(ws, 'hide-value-desktop');
  await evals(ws, `document.querySelector('.total-portfolio-card .icon-btn').click(); return true;`);
  await sleep(300);

  // ── 4. Settings rail: groups + tiles ──
  await evals(ws, `document.querySelector('[aria-label="Settings"]').click(); return true;`);
  await sleep(500);
  const rail = JSON.parse(await evals(ws, `
    return JSON.stringify({
      groups: [...document.querySelectorAll('.settings-nav-group-title')].map(t=>t.textContent.trim()),
      tiles: document.querySelectorAll('.settings-nav-ico').length,
      items: [...document.querySelectorAll('.settings-nav-item')].map(b=>b.textContent.trim()),
    });
  `));
  console.log('  rail:', JSON.stringify(rail));
  ok('rail groups render', rail.groups.length === 3 && rail.groups[0] === 'General', JSON.stringify(rail.groups));
  ok('all 9 icon tiles render', rail.tiles === 9, 'tiles=' + rail.tiles);
  await shot(ws, 'settings-rail-desktop');
  // Switch sections still works.
  await evals(ws, `[...document.querySelectorAll('.settings-nav-item')].find(b=>b.textContent.includes('Preview')).click(); return true;`);
  await sleep(300);
  ok('section switch works', await evals(ws, `return document.querySelector('.settings-content-title').textContent.trim() === 'Preview';`));
  await shot(ws, 'settings-rail-preview');

  // ── 5. Preview self-heal on a stale page (no demo-data.js tag), mobile size ──
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp(ws, 'Page.navigate', { url: `http://localhost:${PORT}/__stale.html` });
  await sleep(1500);
  const mounted2 = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  ok('stale page mounted', mounted2);
  ok('PB_DEMO absent on stale page', await evals(ws, `return typeof window.PB_DEMO === 'undefined';`));
  // Drive the real Settings UI like a phone user would.
  await evals(ws, `document.querySelector('[aria-label="Settings"]').click(); return true;`);
  await sleep(400);
  await evals(ws, `[...document.querySelectorAll('.settings-nav-item')].find(b=>b.textContent.includes('Preview')).click(); return true;`);
  await sleep(300);
  await evals(ws, `[...document.querySelectorAll('.seg-toggle .seg-opt')].find(b=>b.textContent==='On').click(); return true;`);
  const healed = await evals(ws, `const dl=Date.now()+8000; while(Date.now()<dl){ if(window.PB_DEMO) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  ok('self-heal loaded demo-data.js on demand', healed);
  await sleep(600);
  await evals(ws, `document.querySelector('.settings-overlay .modal-close').click(); return true;`);
  await sleep(400);
  await evals(ws, `document.querySelector('[data-tab="current"]').click(); return true;`);
  await sleep(500);
  const bodyText = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('demo book visible after heal (NVDA)', /NVDA|NVIDIA/.test(bodyText));
  ok('real book hidden after heal', !/Coca-Cola/.test(bodyText));
  ok('preview badge shows', await evals(ws, `return !!document.querySelector('.preview-badge');`));
  await shot(ws, 'preview-selfheal-mobile');
  // Mobile settings chip row (flattened groups) renders.
  await evals(ws, `document.querySelector('[aria-label="Settings"]').click(); return true;`);
  await sleep(400);
  ok('mobile chips show tiles', await evals(ws, `return document.querySelectorAll('.settings-nav-ico').length === 9;`));
  ok('mobile group titles hidden', await evals(ws, `return [...document.querySelectorAll('.settings-nav-group-title')].every(t => getComputedStyle(t).display === 'none');`));
  await shot(ws, 'settings-rail-mobile');

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : '❌ ' + failures + ' CHECK(S) FAILED'}`);
} catch (e) {
  console.error('FATAL', e);
  failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures ? 1 : 0);
}
