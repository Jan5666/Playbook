// Real-browser verification of the multi-list watchlist work:
//  - a stock can belong to several lists at once (listIds array)
//  - topline holds only the watchlist pills (no Add button)
//  - search + sort are interactive icon buttons (search expands; sort popover)
//  - Add lives on the action row beside search/sort
// Run: node backend/test/verify-multi-watchlist.mjs
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
  'pb.watchlist.v2': [
    { id: 'w1', ticker: 'GOOGL', market: 'US', name: 'Alphabet Inc.', listIds: ['default', 'g1'] }, // in two lists
    { id: 'w2', ticker: 'AAPL', market: 'US', name: 'Apple Inc.', listIds: ['g1'] },
    { id: 'w3', ticker: 'TSLA', market: 'US', name: 'Tesla Inc.' }, // legacy, no listIds → default
  ],
  'pb.watchlistGroups.v1': [{ id: 'g1', name: 'Tech', createdAt: '2026-01-01T00:00:00.000Z' }],
  'pb.prices.v1': {
    'US:GOOGL': { price: 368.03, change: 4.24, changePct: 1.17, prevClose: 363.79, yearHigh: 408.5, currency: 'USD', fetchedAt: Date.now() },
    'US:AAPL': { price: 232.1, change: -1.8, changePct: -0.77, prevClose: 233.9, yearHigh: 260.1, currency: 'USD', fetchedAt: Date.now() },
    'US:TSLA': { price: 412.0, change: 6.0, changePct: 1.48, prevClose: 406.0, yearHigh: 414.0, currency: 'USD', fetchedAt: Date.now() },
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
<script src="/pb-view-hot.js"></script>
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
  writeFileSync(join(SHOTS, `multi-watchlist-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot multi-watchlist-${name}.png`);
}

let chrome, userDir, failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-mwatch-'));
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
  await sleep(500);
  await evals(ws, `const b=document.querySelector('[data-tab="watchlist"]'); if(b) b.click(); return true;`);
  await sleep(600);
  await shot(ws, 'toolbar');

  // 1. Topline = pills only; Add lives on the action row.
  const toolbar = await evals(ws, `
    return JSON.stringify({
      addInTabbar: !!document.querySelector('.wl-tabbar .wl-add-btn'),
      addInToolbar: !!document.querySelector('.wl-toolbar .wl-add-btn'),
      iconBtns: document.querySelectorAll('.wl-toolbar .wl-iconbtn').length,
      hasSearchPill: !!document.querySelector('.wl-toolbar .wl-search2'),
      hasSortBtn: !!document.querySelector('.wl-toolbar .wl-sortwrap .wl-iconbtn'),
      tabs: Array.from(document.querySelectorAll('.wl-tabs .wl-tab')).map(t => t.textContent.replace(/\\s+/g,' ').trim()),
    });
  `);
  console.log('  toolbar:', toolbar);
  const T = JSON.parse(toolbar);
  ok('Add button NOT on the topline (pills only)', T.addInTabbar === false);
  ok('Add button on the action row', T.addInToolbar === true);
  ok('search + sort render as icon buttons', T.iconBtns >= 2 && T.hasSearchPill && T.hasSortBtn);
  ok('All tab counts every tracked stock (3)', /^All.*3$/.test(T.tabs.find(x => x.startsWith('All')) || ''));
  ok('Watchlist (default) shows 2 (GOOGL + TSLA)', /Watchlist.*2$/.test(T.tabs.find(x => x.startsWith('Watchlist')) || ''));
  ok('Tech list shows 2 (GOOGL + AAPL)', /Tech.*2$/.test(T.tabs.find(x => x.startsWith('Tech')) || ''));

  // 2. Search icon expands the field (iOS-style).
  await evals(ws, `document.querySelector('.wl-search2 .wl-iconbtn').click(); return true;`);
  await sleep(450);
  const searchOpen = await evals(ws, `return !!document.querySelector('.wl-search2.open') && document.activeElement === document.querySelector('.wl-search2-input');`);
  ok('tapping search expands the field and focuses it', searchOpen === true);
  await shot(ws, 'search-open');
  await evals(ws, `document.querySelector('.wl-search2 .wl-iconbtn').click(); return true;`); // collapse
  await sleep(300);

  // 3. Sort icon opens a popover menu; picking an option flags the button active.
  await evals(ws, `document.querySelector('.wl-sortwrap .wl-iconbtn').click(); return true;`);
  await sleep(350);
  const menuOpen = await evals(ws, `return document.querySelectorAll('.wl-sortmenu .wl-sortmenu-row').length;`);
  ok('tapping sort opens the popover with options', menuOpen >= 4);
  await shot(ws, 'sort-open');
  await evals(ws, `const rows=[...document.querySelectorAll('.wl-sortmenu-row')]; const r=rows.find(x=>/Name/.test(x.textContent)); if(r) r.click(); return true;`);
  await sleep(300);
  const sortActive = await evals(ws, `return !!document.querySelector('.wl-sortwrap .wl-iconbtn.on') && !!document.querySelector('.wl-sortwrap .wl-iconbtn-dot');`);
  ok('applied sort marks the sort icon active (dot shown)', sortActive === true);

  // 4. Multi-list: GOOGL shows under BOTH the default and the Tech lists.
  const techTickers = await evals(ws, `
    const tabs=[...document.querySelectorAll('.wl-tabs .wl-tab')]; const t=tabs.find(x=>x.textContent.includes('Tech')); if(t) t.click();
    await new Promise(r=>setTimeout(r,400));
    return Array.from(document.querySelectorAll('.watchlist-list .tkr')).map(e=>e.textContent.trim());
  `);
  console.log('  Tech list:', techTickers);
  ok('Tech list contains GOOGL and AAPL', techTickers.includes('GOOGL') && techTickers.includes('AAPL') && !techTickers.includes('TSLA'));

  // Manage = an edit icon on the action row that opens the same animated popover.
  const manage = await evals(ws, `
    return JSON.stringify({
      oldManageBarGone: !document.querySelector('.wl-manage'),
      editBtns: document.querySelectorAll('.wl-toolbar .wl-iconbtn').length, // search + sort + edit
      hasEdit: document.querySelectorAll('.wl-toolbar .wl-sortwrap').length >= 2,
    });
  `);
  console.log('  manage:', manage);
  const M = JSON.parse(manage);
  ok('old management bar removed', M.oldManageBarGone === true);
  ok('edit icon present on the action row (3 icon buttons)', M.editBtns === 3 && M.hasEdit === true);
  // Open the edit popover (the last .wl-sortwrap holds the edit/manage button).
  await evals(ws, `const wraps=[...document.querySelectorAll('.wl-toolbar .wl-sortwrap')]; wraps[wraps.length-1].querySelector('.wl-iconbtn').click(); return true;`);
  await sleep(350);
  const managePop = await evals(ws, `
    const rows=[...document.querySelectorAll('.wl-sortmenu .wl-sortmenu-row')].map(r=>r.textContent.trim());
    return JSON.stringify({ rows, hasDanger: !!document.querySelector('.wl-sortmenu-row.wl-danger') });
  `);
  console.log('  manage popover:', managePop);
  const MP = JSON.parse(managePop);
  ok('manage popover offers Rename + Delete', MP.rows.some(r => /Rename/.test(r)) && MP.rows.some(r => /Delete/.test(r)) && MP.hasDanger);
  await shot(ws, 'manage-open');
  // Rename reveals an inline input inside the same popover.
  await evals(ws, `const r=[...document.querySelectorAll('.wl-sortmenu-row')].find(x=>/Rename/.test(x.textContent)); if(r) r.click(); return true;`);
  await sleep(300);
  const renameInput = await evals(ws, `return !!document.querySelector('.wl-sortmenu .wl-rename-row .wl-inline-input');`);
  ok('Rename reveals an inline input in the popover', renameInput === true);
  await evals(ws, `const bd=document.querySelector('.wl-pop-backdrop'); if(bd) bd.click(); return true;`); // close
  await sleep(250);

  const defTickers = await evals(ws, `
    const tabs=[...document.querySelectorAll('.wl-tabs .wl-tab')]; const t=tabs.find(x=>x.textContent.trim().startsWith('Watchlist')); if(t) t.click();
    await new Promise(r=>setTimeout(r,400));
    return Array.from(document.querySelectorAll('.watchlist-list .tkr')).map(e=>e.textContent.trim());
  `);
  console.log('  Watchlist (default):', defTickers);
  ok('default Watchlist contains GOOGL and TSLA (GOOGL in both)', defTickers.includes('GOOGL') && defTickers.includes('TSLA') && !defTickers.includes('AAPL'));

  // 5. Stock-card control is multi-select and reflects current membership.
  await evals(ws, `
    const tabs=[...document.querySelectorAll('.wl-tabs .wl-tab')]; const t=tabs.find(x=>x.textContent.trim().startsWith('All')); if(t) t.click();
    await new Promise(r=>setTimeout(r,300));
    const card=document.querySelector('.watchlist-list .swipe-card-inner'); if(card) card.click(); // GOOGL is first
    await new Promise(r=>setTimeout(r,500));
    const toggle=document.querySelector('.wl-control .wl-toggle'); if(toggle) toggle.click(); // open panel
    return true;
  `);
  await sleep(450);
  const control = await evals(ws, `
    const checks=[...document.querySelectorAll('.wl-control .wl-panel .wl-list-row')];
    return JSON.stringify({
      rows: checks.length,
      onCount: document.querySelectorAll('.wl-control .wl-panel .wl-check.on').length,
      hasCheckboxes: !!document.querySelector('.wl-control .wl-check'),
    });
  `);
  console.log('  control:', control);
  const C = JSON.parse(control);
  ok('card control shows list checkboxes', C.hasCheckboxes === true);
  ok('GOOGL ticked into 2 lists (Watchlist + Tech)', C.onCount === 2);
  await shot(ws, 'card-control');

  // 6. Toggling a list off updates membership (and persists).
  await evals(ws, `
    const rows=[...document.querySelectorAll('.wl-control .wl-panel .wl-list-row')];
    const tech=rows.find(r=>/Tech/.test(r.textContent)); if(tech) tech.click();
    return true;
  `);
  await sleep(450);
  const afterToggle = await evals(ws, `
    const wl=JSON.parse(localStorage.getItem('pb.watchlist.v2')||'[]');
    const g=wl.find(w=>w.ticker==='GOOGL');
    return JSON.stringify({ listIds: (g&&g.listIds)||null });
  `);
  console.log('  after toggle off Tech:', afterToggle);
  const A = JSON.parse(afterToggle);
  ok('toggling Tech off leaves GOOGL only in default', !!A.listIds && A.listIds.length === 1 && A.listIds[0] === 'default');

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) {
  console.error('ERROR', e); failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
