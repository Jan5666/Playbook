// Real-browser verification of per-fund sector weightings + the dedicated
// allocation editor reachable from the sector-breakdown popup:
//   • a fund with seeded sector weights splits across multiple sector wedges
//   • tapping a sector wedge opens the holdings popup
//   • each holding row exposes an "edit allocation" button (.sh-row-edit)
//   • that button opens the dedicated "Sector allocation" modal
// Run: node backend/test/verify-sector-weights.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS = join(ROOT, 'test-screenshots');
const PORT = 9924;
const DBG = 9234;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// AAPL (pure Technology) + VOO (an ETF given an explicit 3-sector breakdown).
const SEED = {
  'pb.positions.v2': [
    { id: 'p1', ticker: 'AAPL', market: 'US', shares: 10, costBasis: 150, name: 'Apple Inc.', purchaseDate: '2024-02-01', buyFx: 1 },
    { id: 'p2', ticker: 'VOO', market: 'US', shares: 20, costBasis: 380, name: 'Vanguard S&P 500 ETF', purchaseDate: '2024-03-01', buyFx: 1 },
  ],
  'pb.prices.v1': {
    'US:AAPL': { price: 190, change: 1.2, changePct: 0.63, prevClose: 188.8, currency: 'USD', fetchedAt: Date.now() },
    'US:VOO': { price: 500, change: 2, changePct: 0.4, prevClose: 498, currency: 'USD', fetchedAt: Date.now() },
  },
  'pb.sectorWeights.v1': {
    'US:VOO': [
      { sector: 'Technology', weight: 30 },
      { sector: 'Healthcare', weight: 20 },
      { sector: 'Financial Services', weight: 50 },
    ],
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
  writeFileSync(join(SHOTS, `sectorw-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot sectorw-${name}.png`);
}

let chrome, userDir, pass = true;
const check = (label, ok) => { console.log((ok ? '  PASS: ' : '  FAIL: ') + label); if (!ok) pass = false; };
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-sectorw-'));
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
  check('app mounted', mounted);
  await sleep(900);

  // Dashboard tab (default), find the allocation pie's "Sector" toggle and click.
  const toSector = await evals(ws, `
    const b=[...document.querySelectorAll('.chart-range-btn')].find(x=>x.textContent.trim()==='Sector');
    if(!b) return false; b.click(); return true;`);
  check('switched allocation chart to Sector mode', toSector);
  await sleep(500);

  // The VOO split should produce Technology / Healthcare / Financial Services
  // wedges (Healthcare + Financial Services come *only* from the fund split).
  const labels = JSON.parse(await evals(ws, `
    const ls=[...document.querySelectorAll('.chart-pie-legend-tkr')].map(x=>x.textContent.trim());
    return JSON.stringify(ls);`));
  console.log('  sector legend:', JSON.stringify(labels));
  check('fund split created a Healthcare wedge', labels.includes('Healthcare'));
  check('fund split created a Financial Services wedge', labels.includes('Financial Services'));
  await shot(ws, 'pie-sector');

  // Open the Technology sector popup (AAPL + VOO's 30% share live here).
  const opened = await evals(ws, `
    const it=[...document.querySelectorAll('.chart-pie-legend-item')].find(x=>{const t=x.querySelector('.chart-pie-legend-tkr');return t&&t.textContent.trim()==='Technology';});
    if(!it) return false; it.click(); return true;`);
  check('opened the Technology holdings popup', opened);
  await sleep(450);

  const popupInfo = JSON.parse(await evals(ws, `
    const rows=[...document.querySelectorAll('.sh-row')];
    const edits=[...document.querySelectorAll('.sh-row-edit')];
    const tickers=[...document.querySelectorAll('.sh-row-tkr')].map(x=>x.textContent.trim());
    return JSON.stringify({ rows: rows.length, edits: edits.length, tickers });`));
  console.log('  popup:', JSON.stringify(popupInfo));
  check('popup lists the holdings in the sector', popupInfo.rows >= 1);
  check('every row exposes an edit-allocation button', popupInfo.edits === popupInfo.rows);
  await shot(ws, 'popup');

  // Click the edit button on the VOO row → the dedicated allocation modal opens.
  const editOpened = await evals(ws, `
    const rows=[...document.querySelectorAll('.sh-row')];
    const vooRow=rows.find(r=>{const t=r.querySelector('.sh-row-tkr');return t&&t.textContent.trim()==='VOO';});
    const btn=vooRow&&vooRow.querySelector('.sh-row-edit');
    if(!btn) return false; btn.click(); return true;`);
  check('clicked VOO edit-allocation button', editOpened);
  await sleep(450);

  const modal = JSON.parse(await evals(ws, `
    const title=document.querySelector('.modal-title');
    const sub=document.querySelector('.modal-subtitle');
    const rows=document.querySelectorAll('.sector-split-row').length;
    const sums=[...document.querySelectorAll('.sector-split-sum')].map(x=>x.textContent.trim());
    return JSON.stringify({ title: title?title.textContent.trim():null, sub: sub?sub.textContent.trim():null, rows, sums });`));
  console.log('  alloc modal:', JSON.stringify(modal));
  check('dedicated "Sector allocation" modal opened', modal.title === 'Sector allocation');
  check('modal is scoped to the tapped instrument (VOO)', !!modal.sub && modal.sub.includes('VOO'));
  check('modal pre-loaded the 3 seeded weight rows', modal.rows === 3);
  check('modal shows the running total (100%)', modal.sums.some(s => s.replace(/\s/g, '') === 'Total100%'));
  await shot(ws, 'alloc-modal');

  ws.close();
  console.log(pass ? '\nRESULT: all checks PASSED' : '\nRESULT: some checks FAILED');
} catch (e) {
  console.error('ERROR', e); pass = false;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(pass ? 0 : 1);
}
