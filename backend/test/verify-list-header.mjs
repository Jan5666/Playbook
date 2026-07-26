// Real-browser verification of the holdings-list header + spacing/size tweaks:
//   • a subtle header (Holding · P/L · Current value) sits atop the Holdings
//     and TFSA lists, with the value label right-aligned to the value column
//   • extra space between the Holding (name) column and the P/L column
//   • the P/L amount and the current-value figure share one font size
// Run: node backend/test/verify-list-header.mjs
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
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
<script src="/pb-import.js"></script>
<script src="/pb-views.js"></script>
<script src="/pb-modals.js"></script>
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
// Transient CDP failures, NOT page failures. Chrome creates an execution context
// for the initial about:blank and destroys it when the harness URL commits, so an
// evaluate issued in that window dies with "Execution context was destroyed"
// before the page has done anything wrong. We attach as soon as /json lists the
// target -- which is exactly that window -- so the race is structural, not
// unlucky: on a slow or loaded machine it reproduces every run. This retry is the
// one verify-refresh-behavior.mjs (the mount gate) has always had; GAPS.md #12(b)
// is propagating it to the harnesses that were left flaky without it.
//
// Only the transient CDP error is retried, NEVER a page exception: that is a real
// failure, and re-running an expression with side effects would be wrong. Retrying
// the transient case is safe because a destroyed context ran nothing.
const TRANSIENT_CDP = /context was destroyed|Cannot find context|Execution context with given id not found|Inspected target navigated or closed/i;
async function evals(ws, expr, timeout = 20000) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await cdp(ws, 'Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, timeout });
      if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
      return r.result.value;
    } catch (e) {
      last = e;
      if (!TRANSIENT_CDP.test(String((e && e.message) || e))) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw last;
}
async function shot(ws, name) {
  const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(SHOTS, `listhead-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot listhead-${name}.png`);
}

// Inspect the header + first row in the currently visible list.
const inspect = `
  const head=document.querySelector('.holding-list-head');
  const row=document.querySelector('.holding-row');
  if(!head||!row) return JSON.stringify({head:!!head,row:!!row});
  const labels=[...head.children].map(c=>c.textContent);
  const valLabel=head.querySelector('.hlh-val');
  const glLabel=head.querySelector('.hlh-gl');
  const rowVal=row.querySelector('.holding-value');
  const rowGlAmt=row.querySelector('.holding-gl-amt');
  const cs=getComputedStyle;
  const glBox=row.querySelector('.holding-gl');
  return JSON.stringify({
    labels,
    valFont: cs(rowVal).fontSize,
    glAmtFont: cs(rowGlAmt).fontSize,
    glMarginLeft: cs(glBox).marginLeft,
    valLabelRight: Math.round(valLabel.getBoundingClientRect().right),
    rowValRight: Math.round(rowVal.getBoundingClientRect().right),
    glLabelRight: Math.round(glLabel.getBoundingClientRect().right),
    rowGlRight: Math.round(rowGlAmt.getBoundingClientRect().right),
  });`;

let chrome, userDir, fail = false;
const check = (name, ok, detail) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fail = true; };

try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-listhead-'));
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

  for (const [tab, name] of [['current', 'holdings'], ['tfsa', 'tfsa']]) {
    await evals(ws, `const b=document.querySelector('[data-tab="${tab}"]'); if(b) b.click(); return true;`);
    await sleep(700);
    const data = JSON.parse(await evals(ws, inspect));
    console.log(`\n  [${name}]`, JSON.stringify(data));
    if (!data.labels) { check(`${name}: header + row present`, false, JSON.stringify(data)); continue; }
    check(`${name}: header labels`, JSON.stringify(data.labels) === JSON.stringify(['Holding', 'P/L', 'Current value']), data.labels.join(' / '));
    check(`${name}: P/L amount == value font size`, data.valFont === data.glAmtFont, `value ${data.valFont} vs P/L ${data.glAmtFont}`);
    check(`${name}: extra Holding↔P/L space`, parseFloat(data.glMarginLeft) >= 8, `margin-left ${data.glMarginLeft}`);
    check(`${name}: value label aligned to value column`, Math.abs(data.valLabelRight - data.rowValRight) <= 2, `label ${data.valLabelRight} vs col ${data.rowValRight}`);
    await shot(ws, name);
  }

  ws.close();
  console.log('\n' + (fail ? 'RESULT: some checks FAILED' : 'RESULT: all checks PASSED'));
} catch (e) {
  console.error('ERROR', e);
  fail = true;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(fail ? 1 : 0);
}
