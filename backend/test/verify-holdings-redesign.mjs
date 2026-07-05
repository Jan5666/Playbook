// Real-browser verification of the Holdings/TFSA row redesign:
//   • ticker is now the main heading with a small market badge beside it
//   • company name + "Avg cost <price>" sit on the sub-line
//   • boxes are slightly shorter but still uniform height
// Run: node backend/test/verify-holdings-redesign.mjs
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

// US + JSE + TFSA holdings, with one deliberately long instrument name so the
// sub-line ellipsis + uniform-height behaviour is exercised.
const SEED = {
  'pb.positions.v2': [
    { id: 'p1', ticker: 'AAPL', market: 'US', shares: 12, costBasis: 150, name: 'Apple Inc.', purchaseDate: '2024-02-01', buyFx: 1 },
    { id: 'p2', ticker: 'GOOGL', market: 'US', shares: 5, costBasis: 120.5, name: 'Alphabet Inc. Class A', purchaseDate: '2024-03-01', buyFx: 1 },
    { id: 'p3', ticker: 'NPN', market: 'JSE', shares: 8, costBasis: 2950, name: 'Naspers Limited', purchaseDate: '2024-01-15', buyFx: 1 },
    { id: 'p4', ticker: 'STXNDQ', market: 'TFSA', shares: 40, costBasis: 88.4, name: 'Satrix Nasdaq 100 Feeder Portfolio ETF', purchaseDate: '2024-04-01', buyFx: 1 },
    { id: 'p5', ticker: 'STX40', market: 'TFSA', shares: 30, costBasis: 72.1, name: 'Satrix 40 ETF', purchaseDate: '2024-05-01', buyFx: 1 },
  ],
  'pb.prices.v1': {
    'US:AAPL': { price: 190, change: 1.2, changePct: 0.63, prevClose: 188.8, currency: 'USD', fetchedAt: Date.now() },
    'US:GOOGL': { price: 138.2, change: -0.9, changePct: -0.65, prevClose: 139.1, currency: 'USD', fetchedAt: Date.now() },
    'JSE:NPN': { price: 3420, change: 25, changePct: 0.74, prevClose: 3395, currency: 'ZAR', fetchedAt: Date.now() },
    'TFSA:STXNDQ': { price: 102.6, change: 0.8, changePct: 0.79, prevClose: 101.8, currency: 'ZAR', fetchedAt: Date.now() },
    'TFSA:STX40': { price: 70.3, change: -0.4, changePct: -0.57, prevClose: 70.7, currency: 'ZAR', fetchedAt: Date.now() },
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
  writeFileSync(join(SHOTS, `holdings-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot holdings-${name}.png`);
}

// Click a Holdings sub-tab (US / JSE / TFSA) by its visible label.
const clickMarket = (label) => `
  const b=[...document.querySelectorAll('.toggle-opt-market')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(label)}));
  if(!b) return false; b.click(); return true;`;

// Inspect every holding row currently rendered.
const inspect = `
  const rows=[...document.querySelectorAll('.holding-row')];
  return JSON.stringify(rows.map(r=>{
    const tkr=r.querySelector('.hold-tkr-main');
    const badge=r.querySelector('.mkt-badge');
    const co=r.querySelector('.hold-co-name');
    const avg=r.querySelector('.hold-avg');
    return {
      h: Math.round(r.getBoundingClientRect().height),
      tkr: tkr?tkr.textContent:null,
      badge: badge?badge.textContent:null,
      co: co?co.textContent:null,
      avg: avg?avg.textContent:null,
    };
  }));`;

let chrome, userDir;
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-holdings-'));
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
  await sleep(800);

  // Go to Holdings tab.
  await evals(ws, `const b=document.querySelector('[data-tab="current"]'); if(b) b.click(); return true;`);
  await sleep(600);

  let allHeights = [];
  // Sub-tab labels come from MARKET_LABELS (US→USA, JSE→SA, TFSA→TFSA).
  for (const [m, label] of [['US', 'USA'], ['JSE', 'SA'], ['TFSA', 'TFSA']]) {
    const ok = await evals(ws, clickMarket(label));
    await sleep(500);
    const data = JSON.parse(await evals(ws, inspect));
    console.log(`\n  [${m}] tab clicked:`, ok, '— rows:', data.length);
    for (const r of data) console.log('   ', JSON.stringify(r));
    allHeights.push(...data.map(r => r.h));
    await shot(ws, m.toLowerCase());
  }

  const uniq = [...new Set(allHeights)];
  const spread = Math.max(...allHeights) - Math.min(...allHeights);
  console.log('\n  row heights:', JSON.stringify(allHeights), '— distinct:', JSON.stringify(uniq), '— spread:', spread + 'px');
  console.log(spread <= 1 ? '  PASS: holding boxes are uniform height' : '  WARN: holding boxes vary in height');

  ws.close();
  console.log('done');
} catch (e) {
  console.error('ERROR', e);
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
}
