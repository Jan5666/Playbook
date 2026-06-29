// Verifies the price-refresh fast-path fixes for the holdings "today" move:
//   1. The header Refresh button is never a no-op — a click issues a fresh sweep.
//   2. A manual refresh cache-busts (inner Yahoo URL carries &_=) so shared CORS
//      proxies can't serve a stale cached quote; the auto-poll does NOT cache-bust.
//   3. The user's own positions are fetched BEFORE the static recommendation
//      lists (VOO lands last), so the portfolio "today" move repaints first.
//   4. The portfolio "Today" pill renders from the merged quotes.
// Network is fully mocked: every Yahoo chart request (via the corsmirror proxy
// shape the app tries first) returns a crafted quote, and each call is logged.
// Run: node backend/test/verify-refresh-behavior.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const PORT = 9924;
const DBG = 9234;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SEED = {
  'pb.positions.v2': [
    { id: 'p1', ticker: 'AAPL', market: 'US', shares: 12, costBasis: 150, name: 'Apple Inc.', purchaseDate: '2024-02-01', buyFx: 1 },
    { id: 'p2', ticker: 'GOOGL', market: 'US', shares: 5, costBasis: 120.5, name: 'Alphabet Inc. Class A', purchaseDate: '2024-03-01', buyFx: 1 },
  ],
};
const seedJson = JSON.stringify(SEED).replace(/</g, '\\u003c');

// A per-symbol up-day quote. The page's mock fetch reads PRICES[sym] (default
// 100/95). regularMarketTime ≈ now ⇒ the quote isn't "stale", so fetchQuote
// makes a single request per symbol (no intraday re-shoot) — keeps the log clean.
const VERIFY_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="/styles.css">
</head><body>
<div id="root"></div>
<script>
  try { const s = ${seedJson}; for (const k in s) localStorage.setItem(k, JSON.stringify(s[k])); } catch(e){}
  window.__log = [];
  const PRICES = { AAPL: [200, 190], GOOGL: [150, 140] };
  function quoteJSON(sym) {
    const [price, prev] = PRICES[sym] || [100, 95];
    return JSON.stringify({ chart: { result: [ { meta: {
      regularMarketPrice: price, chartPreviousClose: prev, regularMarketPreviousClose: prev,
      previousClose: prev, currency: 'USD', regularMarketTime: Math.floor(Date.now()/1000),
      shortName: sym, marketState: 'REGULAR'
    } } ] } });
  }
  window.fetch = async (u, o) => {
    const s = String(u || '');
    // The app wraps Yahoo in corsmirror first: https://corsmirror.com/v1?url=ENCODED
    let inner = null;
    try { inner = new URL(s).searchParams.get('url'); } catch (e) {}
    if (inner && inner.includes('/v8/finance/chart/')) {
      let sym = '';
      try { sym = decodeURIComponent(inner.split('/chart/')[1].split('?')[0]); } catch (e) {}
      window.__log.push({ sym, cb: /[?&]_=/.test(inner), t: performance.now() });
      return new Response(quoteJSON(sym), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Everything else (FX, news, etc.) — benign empty payload, no network.
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
</script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="/pb-core.js"></script>
<script src="/pb-data.js"></script>
<script src="/pb-store.js"></script>
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
  // The page may swap execution contexts once during initial load; retry so a
  // single "context was destroyed" race doesn't fail the run.
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await cdp(ws, 'Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, timeout });
      if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
      return r.result.value;
    } catch (e) {
      last = e;
      if (!/context was destroyed|Cannot find context/i.test(String(e.message))) throw e;
      await sleep(500);
    }
  }
  throw last;
}

let chrome, userDir, failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failures++; };
try {
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-refresh-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=440,1100',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  await sleep(900); // let the initial document finish loading before first eval

  const mounted = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  console.log('  app mounted:', mounted);
  ok('app mounts', mounted === true);

  // Let the initial AUTO poll finish, then snapshot its log and clear.
  await sleep(2500);
  const autoLog = JSON.parse(await evals(ws, `return JSON.stringify(window.__log);`));
  console.log('  auto-poll requests:', autoLog.length);
  ok('auto-poll fetched the positions', autoLog.some(e => e.sym === 'AAPL') && autoLog.some(e => e.sym === 'GOOGL'));
  ok('auto-poll does NOT cache-bust', autoLog.length > 0 && autoLog.every(e => e.cb === false));

  // Phase 2 inc 3: the routine cold-start poll must NOT include the static
  // recommendation lists (DATA.NEW_PICKS / DATA.HEDGES) or the dead VOO benchmark
  // — they are now lazy/on-view. This is the regression that proves fan-out dropped.
  const lazySyms = JSON.parse(await evals(ws, `return JSON.stringify([...DATA.NEW_PICKS, ...DATA.HEDGES].map(x => x.ticker).concat('VOO'));`));
  const polledLazy = [...new Set(autoLog.filter(e => lazySyms.includes(e.sym)).map(e => e.sym))];
  ok('cold start excludes static lists (picks/hedges/VOO)', polledLazy.length === 0, polledLazy.join(',') || 'none');

  // Ordering: the user's positions must be requested before VOO (now last).
  const firstPos = Math.min(
    autoLog.findIndex(e => e.sym === 'AAPL'),
    autoLog.findIndex(e => e.sym === 'GOOGL'));
  const vooIdx = autoLog.findIndex(e => e.sym === 'VOO');
  ok('positions are fetched before VOO (positions-first ordering)',
     firstPos >= 0 && (vooIdx === -1 || firstPos < vooIdx),
     `firstPos=${firstPos} voo=${vooIdx}`);

  // The portfolio "Today" pill should have rendered (AAPL & GOOGL are up days).
  const todayPill = await evals(ws, `const el=document.querySelector('.dash-today-val, .hsum-today'); return el ? el.textContent.trim() : null;`);
  ok('portfolio "Today" pill renders', !!todayPill, String(todayPill));

  // ---- MANUAL REFRESH ----
  await evals(ws, `window.__log = []; return true;`);
  const clicked = await evals(ws, `const b=document.querySelector('.refresh-btn'); if(!b) return false; b.click(); return true;`);
  ok('refresh button exists & clickable', clicked === true);
  await sleep(2500);
  const manualLog = JSON.parse(await evals(ws, `return JSON.stringify(window.__log);`));
  console.log('  manual-refresh requests:', manualLog.length);
  ok('refresh button is NOT a no-op (issues a fresh sweep)', manualLog.length > 0);
  ok('manual refresh fetched the positions', manualLog.some(e => e.sym === 'AAPL') && manualLog.some(e => e.sym === 'GOOGL'));
  ok('manual refresh cache-busts every request (&_=)', manualLog.length > 0 && manualLog.every(e => e.cb === true));

  // ---- LAZY TAB ACTIVATION: opening Picks warms its list AND floats it to front ----
  await evals(ws, `window.__log = []; return true;`);
  const wentPicks = await evals(ws, `const b=document.querySelector('button[data-tab="picks"]'); if(!b) return false; b.click(); return true;`);
  ok('picks tab nav button exists & clickable', wentPicks === true);
  await sleep(2500);
  const picksLog = JSON.parse(await evals(ws, `return JSON.stringify(window.__log);`));
  const picksSyms = JSON.parse(await evals(ws, `return JSON.stringify(DATA.NEW_PICKS.map(p => p.ticker));`));
  const firstPickIdx = picksLog.findIndex(e => picksSyms.includes(e.sym));
  ok('opening Picks fetches its list (lazy warm)', firstPickIdx >= 0);
  const firstPosIdx2 = Math.min(...['AAPL', 'GOOGL'].map(s => { const i = picksLog.findIndex(e => e.sym === s); return i < 0 ? Infinity : i; }));
  ok('active Picks list floats to the front of the sweep', firstPickIdx >= 0 && firstPickIdx < firstPosIdx2, `pick=${firstPickIdx} pos=${firstPosIdx2}`);


  // ---- REFRESH-CONFIDENCE STATUS (now folded into the refresh button) ----
  // The relative-time/state label lives in the always-rendered .refresh-peek-text
  // (visually revealed only on a press-and-hold peek); a tap on .refresh-btn refreshes.
  const chipText0 = await evals(ws, `return document.querySelector('.refresh-peek-text')?.textContent || '';`);
  ok('refresh control exposes relative/state text (not bare HH:MM)', /ago|just now|Updating|Updated|Loading/i.test(chipText0), JSON.stringify(chipText0));
  await evals(ws, `const c=document.querySelector('.refresh-btn'); if(c) c.click(); return true;`);
  const chipText1 = await evals(ws, `return document.querySelector('.refresh-peek-text')?.textContent || '';`);
  ok('tapping the button flips status to Updating… instantly', /Updating/i.test(chipText1), JSON.stringify(chipText1));
  await sleep(3000);
  const chipText2 = await evals(ws, `return document.querySelector('.refresh-peek-text')?.textContent || '';`);
  ok('status settles to Updated/relative after the sweep', /Updated|ago/i.test(chipText2), JSON.stringify(chipText2));


  // ---- PER-SYMBOL SESSION BADGE: a closed/quiet market reads as state, not blank ----
  await evals(ws, `const d=document.querySelector('button[data-tab="picks"]'); if(d) d.click(); return true;`);
  await sleep(800);
  const badge = await evals(ws, `const b=document.querySelector('.session-badge'); return b ? b.innerText : null;`);
  ok('a session badge renders (Open/Closed/Pre-market/After-hours)', !!badge && /Open|Closed|Pre-market|After-hours/i.test(badge), JSON.stringify(badge));


  // Holdings list rows DELIBERATELY omit the per-symbol session badge — Jan removed
  // it from the holdings boxes on purpose (cfed272). Pin the absence so it isn't
  // "fixed" back in: there must be holding rows, but none may carry a session badge.
  await evals(ws, `const c=document.querySelector('button[data-tab="current"]'); if(c) c.click(); return true;`);
  await sleep(800);
  const holdRows = await evals(ws, `return document.querySelectorAll('.holding-row').length;`);
  const holdBadge = await evals(ws, `const b=document.querySelector('.holding-row .session-badge'); return b ? b.innerText : null;`);
  ok('holdings rows deliberately have NO session badge', holdRows > 0 && holdBadge === null, JSON.stringify({ holdRows, holdBadge }));

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) {
  console.error('ERROR', e); failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
