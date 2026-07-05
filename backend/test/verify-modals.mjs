// Real-browser verification of the TFSA-tab spacing + import-modal restyle +
// modal-width consistency work. Serves the project, seeds localStorage with a
// few non-TFSA holdings (so the dashboard's Growth Tracker shows, but the TFSA
// tab stays in its empty state), then screenshots each surface.
// Run: node backend/test/verify-modals.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS = join(ROOT, 'test-screenshots');
const PORT = 9919;
const DBG = 9229;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

// US + JSE holdings only — keeps the TFSA tab empty while the dashboard is full.
const SEED = {
  'pb.positions.v2': [
    { id: 'p1', ticker: 'AAPL', market: 'US', shares: 12, costBasis: 150, name: 'Apple Inc.', purchaseDate: '2024-02-01', buyFx: 1 },
    { id: 'p2', ticker: 'MSFT', market: 'US', shares: 5, costBasis: 300, name: 'Microsoft Corporation', purchaseDate: '2024-03-01', buyFx: 1 },
  ],
  'pb.contributions.v2': [
    { id: 'c1', amount: 5000, currency: 'USD', date: '2024-02-01', note: 'Initial' },
  ],
  'pb.prices.v1': {
    'US:AAPL': { price: 190, change: 1.2, changePct: 0.63, prevClose: 188.8, currency: 'USD', fetchedAt: Date.now() },
    'US:MSFT': { price: 322, change: 2.5, changePct: 0.78, prevClose: 319.5, currency: 'USD', fetchedAt: Date.now() },
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
  writeFileSync(join(SHOTS, `modals-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot modals-${name}.png`);
}

let chrome, userDir;
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-modals-'));
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

  // ── 1. TFSA tab (empty state) ──
  const wentTfsa = await evals(ws, `const b=document.querySelector('[data-tab="tfsa"]'); if(!b) return false; b.click(); return true;`);
  console.log('  TFSA tab clicked:', wentTfsa);
  await sleep(600);
  await shot(ws, 'tfsa-empty');
  // Measure the vertical rhythm: gap empty→Contribution room vs room→info card.
  const rhythm = await evals(ws, `
    const empty=document.querySelector('.empty-tfsa');
    const cards=[...document.querySelectorAll('.collapse-card')];
    if(!empty||cards.length<2) return '(missing)';
    const eb=empty.getBoundingClientRect().bottom;
    const c0=cards[0].getBoundingClientRect();
    const c1=cards[1].getBoundingClientRect();
    return JSON.stringify({ emptyToRoom: Math.round(c0.top-eb), roomToInfo: Math.round(c1.top-c0.bottom) });`);
  console.log('  TFSA rhythm:', rhythm);

  // ── 2. Dashboard → Import deposits & withdrawals modal ──
  await evals(ws, `const b=document.querySelector('[data-tab="dashboard"]')||document.querySelector('[data-tab="home"]'); if(b) b.click(); return true;`);
  await sleep(500);
  const tabs = await evals(ws, `return [...document.querySelectorAll('[data-tab]')].map(b=>b.getAttribute('data-tab'));`);
  console.log('  tabs:', JSON.stringify(tabs));
  // Find & click the "Import" deposits button in the Growth Tracker.
  const opened = await evals(ws, `
    const btn=[...document.querySelectorAll('.growth-deposit-btn')].find(b=>/import/i.test(b.textContent));
    if(!btn) return 'no-import-btn';
    btn.click(); return 'clicked';`);
  console.log('  import-deposits button:', opened);
  await sleep(600);
  const title = await evals(ws, `const t=document.querySelector('.modal-title'); return t?t.textContent:'(none)';`);
  console.log('  modal title:', title);
  await shot(ws, 'import-deposits');
  const panelW = await evals(ws, `const p=document.querySelector('.modal-panel'); return p?Math.round(p.getBoundingClientRect().width):0;`);
  console.log('  import-deposits panel width:', panelW);

  // Close, then open the holdings Import modal as the premium reference.
  await evals(ws, `const x=document.querySelector('.modal-close'); if(x) x.click(); return true;`);
  await sleep(300);
  await evals(ws, `const b=document.querySelector('[data-tab="current"]'); if(b) b.click(); return true;`);
  await sleep(500);
  const openedH = await evals(ws, `
    const btn=[...document.querySelectorAll('button.btn')].find(b=>/^\\s*Import\\s*$/i.test(b.textContent.replace(/\\s+/g,' ').trim()));
    if(!btn) return 'no-import-btn';
    btn.click(); return 'clicked';`);
  console.log('  holdings-import button:', openedH);
  await sleep(700);
  await shot(ws, 'import-holdings');
  await evals(ws, `const x=document.querySelector('.modal-close'); if(x) x.click(); return true;`);
  await sleep(300);

  // ── 4. Width + height consistency: at a real phone viewport every sheet should
  //    open at the same width (520 cap) AND the same height (fixed, not hugging). ──
  const VW = 440, VH = 900;
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const dims = {};
  const measurePanel = async (label, screenshot) => {
    const wh = await evals(ws, `const p=document.querySelector('.modal-panel'); if(!p) return '0x0'; const r=p.getBoundingClientRect(); return Math.round(r.width)+'x'+Math.round(r.height);`);
    dims[label] = wh;
    if (screenshot) await shot(ws, 'h-' + label);
    await evals(ws, `const x=document.querySelector('.modal-close')||document.querySelector('.modal-backdrop'); if(x) x.click(); return true;`);
    await sleep(250);
  };
  // Back to the dashboard, where the deposit buttons live.
  await evals(ws, `const b=document.querySelector('[data-tab="dashboard"]'); if(b) b.click(); return true;`);
  await sleep(400);
  // Log deposit (add) — shortest form.
  await evals(ws, `const b=[...document.querySelectorAll('.growth-deposit-btn')].find(b=>/log deposit/i.test(b.textContent)); if(b) b.click(); return true;`);
  await sleep(400); await measurePanel('log-deposit', true);
  // Import deposits
  await evals(ws, `const b=[...document.querySelectorAll('.growth-deposit-btn')].find(b=>/import/i.test(b.textContent)); if(b) b.click(); return true;`);
  await sleep(400); await measurePanel('import-deposits', true);
  // Add position (Holdings tab)
  await evals(ws, `const b=document.querySelector('[data-tab="current"]'); if(b) b.click(); return true;`);
  await sleep(400);
  await evals(ws, `const b=[...document.querySelectorAll('button.btn')].find(b=>/^\\s*Add\\s*$/i.test(b.textContent.replace(/\\s+/g,' ').trim())); if(b) b.click(); return true;`);
  await sleep(400); await measurePanel('add-position', true);
  // Import holdings — tallest form.
  await evals(ws, `const b=[...document.querySelectorAll('button.btn')].find(b=>/^\\s*Import\\s*$/i.test(b.textContent.replace(/\\s+/g,' ').trim())); if(b) b.click(); return true;`);
  await sleep(500); await measurePanel('import-holdings', true);
  console.log('  panel WxH @' + VW + 'x' + VH + ':', JSON.stringify(dims));

  // ── 5. Stock-detail modal: its scroll moved from panel → body. Confirm the
  //    body is the scroll region, it actually scrolls, and the header stays put. ──
  await evals(ws, `const b=document.querySelector('[data-tab="current"]'); if(b) b.click(); return true;`);
  await sleep(400);
  await evals(ws, `const row=document.querySelector('.holding-row, .pos-card, [class*="holding"]'); if(row) row.click(); return true;`);
  await sleep(700);
  const sd = await evals(ws, `
    const p=document.querySelector('.stock-detail-panel'); if(!p) return '(no stock detail)';
    const body=p.querySelector('.modal-body'); const hdr=p.querySelector('.modal-header');
    if(!body) return '(no body)';
    const before=body.scrollTop; body.scrollTop=400; const after=body.scrollTop;
    const hdrTop=Math.round(hdr.getBoundingClientRect().top);
    return JSON.stringify({ panelH:Math.round(p.getBoundingClientRect().height), bodyScrollable: body.scrollHeight>body.clientHeight+5, scrolled: after>before, headerTopAfterScroll: hdrTop });`);
  console.log('  stock-detail:', sd);
  await shot(ws, 'stock-detail');

  ws.close();
  console.log('done');
} catch (e) {
  console.error('ERROR', e);
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
}
