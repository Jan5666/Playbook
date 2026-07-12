// Real-browser verification of the holdings-edit goal work:
//  1. Opening Edit on a holding does NOT auto-open the live-ticker dropdown.
//  2. The holding's notes show in a dropdown right below the watchlist box.
//  3. Saving an edit prompts to confirm and lists each changed field (old→new).
// Plus a sanity check that typing in the ticker field still opens search.
// Run: node backend/test/verify-goal-holdings.mjs
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
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

const SEED = {
  'pb.positions.v2': [
    { id: 'p1', ticker: 'AAPL', market: 'US', shares: 12, costBasis: 150, name: 'Apple Inc.', purchaseDate: '2024-02-01', buyFx: 1, notes: 'Core holding — bought the COVID dip, hold long term.' },
  ],
  'pb.prices.v1': {
    'US:AAPL': { price: 190, change: 1.2, changePct: 0.63, prevClose: 188.8, currency: 'USD', fetchedAt: Date.now() },
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
<script src="/pb-content.js"></script>
<script src="/pb-import.js"></script>
<script src="/pb-views.js"></script>
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
  writeFileSync(join(SHOTS, `goal-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot goal-${name}.png`);
}

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  → ' + extra : ''}`); };

let chrome, userDir, ws;
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-goal-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=440,1100', '--force-device-scale-factor=2',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 440, height: 1100, deviceScaleFactor: 2, mobile: true });

  const mounted = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  ok('app mounted', mounted === true);
  await sleep(600);

  // Go to Holdings tab
  await evals(ws, `const b=document.querySelector('[data-tab="current"]'); if(b) b.click(); return true;`);
  await sleep(500);
  const rowFound = await evals(ws, `const r=document.querySelector('.holding-row'); if(r){r.click(); return true;} return false;`);
  ok('opened holding detail card', rowFound === true);
  await sleep(700);

  // ── 2. Notes dropdown below the watchlist box ──
  const hn = await evals(ws, `
    const wl=document.querySelector('.wl-control');
    const hnc=document.querySelector('.hn-control');
    if(!wl||!hnc) return JSON.stringify({wl:!!wl,hnc:!!hnc});
    // hn-control must come AFTER the watchlist control in the card.
    const order = (wl.compareDocumentPosition(hnc) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'after' : 'before';
    const toggle = hnc.querySelector('.hn-toggle');
    const label = toggle ? toggle.textContent.trim() : '';
    const panelBefore = !!hnc.querySelector('.hn-note-text');
    return JSON.stringify({ order, label, panelBefore });`);
  const hnObj = JSON.parse(hn);
  ok('notes dropdown sits below watchlist box', hnObj.order === 'after', hn);
  ok('notes dropdown labelled, collapsed by default', /notes/i.test(hnObj.label || '') && hnObj.panelBefore === false);
  // Expand it
  const noteText = await evals(ws, `
    const t=document.querySelector('.hn-toggle'); if(!t) return '(no toggle)'; t.click();
    await new Promise(r=>setTimeout(r,250));
    const n=document.querySelector('.hn-note-text'); return n? n.textContent.trim() : '(no note)';`);
  ok('expanding shows the saved note text', noteText.includes('bought the COVID dip'), noteText);
  await shot(ws, 'notes-dropdown');

  // Close detail modal
  await evals(ws, `const x=document.querySelector('.modal-close'); if(x) x.click(); return true;`);
  await sleep(400);

  // ── 1. Edit does NOT auto-open the live-ticker dropdown ──
  await evals(ws, `const e=document.querySelector('.btn-edit-inline'); if(e) e.click(); return true;`);
  await sleep(900); // longer than the 280ms remote-search debounce
  const editState = await evals(ws, `
    const title=document.querySelector('.modal-title');
    const dd=document.querySelector('.ticker-dropdown');
    const tickerInput=document.querySelector('.ticker-search-input');
    return JSON.stringify({ title: title?title.textContent:'', dropdownOpen: !!dd, tickerVal: tickerInput?tickerInput.value:'' });`);
  const es = JSON.parse(editState);
  ok('edit modal opened', /edit position/i.test(es.title), es.title);
  ok('ticker field pre-filled with existing ticker', es.tickerVal === 'AAPL', es.tickerVal);
  ok('live-ticker dropdown is NOT auto-open on edit', es.dropdownOpen === false);
  await shot(ws, 'edit-no-autodropdown');

  // Sanity: typing in the ticker field DOES open the search dropdown.
  const typed = await evals(ws, `
    const el=document.querySelector('.ticker-search-input'); if(!el) return '(no input)';
    const proto=Object.getPrototypeOf(el); const desc=Object.getOwnPropertyDescriptor(proto,'value');
    el.focus(); desc.set.call(el,'MS'); el.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,300));
    return !!document.querySelector('.ticker-dropdown');`);
  ok('typing in ticker field still opens search dropdown', typed === true);
  // Restore the ticker so we only diff shares below.
  await evals(ws, `
    const el=document.querySelector('.ticker-search-input');
    const proto=Object.getPrototypeOf(el); const desc=Object.getOwnPropertyDescriptor(proto,'value');
    desc.set.call(el,'AAPL'); el.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,100));
    // close the dropdown
    document.body.click(); return true;`);
  await sleep(200);

  // ── 3. Save changes prompts a confirm with field-by-field diff ──
  await evals(ws, `
    const el=document.querySelector('input[placeholder="10"]'); // shares input
    const proto=Object.getPrototypeOf(el); const desc=Object.getOwnPropertyDescriptor(proto,'value');
    desc.set.call(el,'20'); el.dispatchEvent(new Event('input',{bubbles:true}));
    return true;`);
  await sleep(200);
  await evals(ws, `
    const btn=[...document.querySelectorAll('.modal-panel .btn-primary')].find(b=>/save changes/i.test(b.textContent));
    if(btn) btn.click(); return true;`);
  await sleep(500);
  const confirm = await evals(ws, `
    const card=document.querySelector('.import-confirm');
    if(!card) return JSON.stringify({shown:false});
    const title=card.querySelector('.import-confirm-title');
    const rows=[...card.querySelectorAll('.edit-diff-row')].map(r=>({
      label:(r.querySelector('.edit-diff-label')||{}).textContent,
      from:(r.querySelector('.edit-diff-from')||{}).textContent,
      to:(r.querySelector('.edit-diff-to')||{}).textContent }));
    return JSON.stringify({ shown:true, title:title?title.textContent:'', rows });`);
  const cf = JSON.parse(confirm);
  ok('save prompts a confirmation dialog', cf.shown === true && /save these changes/i.test(cf.title || ''), cf.title);
  const sharesRow = (cf.rows || []).find(r => /shares/i.test(r.label || ''));
  ok('confirm lists the changed Shares field (old → new)', !!sharesRow && sharesRow.from === '12' && sharesRow.to === '20', JSON.stringify(sharesRow));
  // Viewport-only capture: the confirm is a position:fixed portal, which a
  // full-page (captureBeyondViewport) screenshot does not render in place.
  { const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, 'goal-edit-confirm-diff.png'), Buffer.from(r.data, 'base64'));
    console.log('  shot goal-edit-confirm-diff.png (viewport)'); }

  // Confirm the save and check it persisted.
  await evals(ws, `
    const btn=[...document.querySelectorAll('.import-confirm .btn-primary')].find(b=>/save changes/i.test(b.textContent));
    if(btn) btn.click(); return true;`);
  await sleep(500);
  const saved = await evals(ws, `
    const closed = !document.querySelector('.import-confirm') && !document.querySelector('.modal-panel');
    const pos = JSON.parse(localStorage.getItem('pb.positions.v2')||'[]')[0];
    return JSON.stringify({ closed, shares: pos? pos.shares : null });`);
  const sv = JSON.parse(saved);
  ok('confirming saves the change and closes modals', sv.closed === true && Number(sv.shares) === 20, saved);

  console.log(`\n  ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('ERROR:', e.message);
  fail++;
} finally {
  try { ws && ws.close(); } catch {}
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  await sleep(300);
  process.exit(fail > 0 ? 1 : 0);
}
