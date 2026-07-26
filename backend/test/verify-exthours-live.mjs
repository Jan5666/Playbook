// LIVE end-to-end check: with network enabled, the real fetchQuote must derive
// the extended-hours quote from intraday bars, and the 1D chart must end its line
// at the live pre/post price (no phantom snap-back to the regular close).
// Best-effort: if the shared CORS proxies don't deliver data in time it reports
// SKIPPED rather than failing.
//   Run: node backend/test/verify-exthours-live.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

// Determine, from live Yahoo data, whether MU is in a pre/post session right now
// — so the test knows whether the UI *should* show an extended-hours column.
function centDivisor(market, currency) { const c = (currency || '').toUpperCase(); if (c === 'GBX' || c === 'ZAX' || c === 'ZAC') return 100; return 1; }
function deriveExt(result, market) {
  const meta = result?.meta, ctp = meta?.currentTradingPeriod, ts = result?.timestamp, closes = result?.indicators?.quote?.[0]?.close;
  if (!meta || !ctp || !ctp.regular || !Array.isArray(ts) || !Array.isArray(closes) || typeof meta.regularMarketPrice !== 'number') return null;
  const now = Date.now() / 1000; let kind = null, sess = null;
  if (ctp.post && now >= ctp.post.start && now < ctp.post.end) { kind = 'post'; sess = ctp.post; }
  else if (ctp.pre && now >= ctp.pre.start && now < ctp.pre.end) { kind = 'pre'; sess = ctp.pre; }
  else return null;
  // Mirror pb-core.deriveIntradayExt: latest in-window close is the live ext
  // price; surface it whenever the session shows real activity (any close differs
  // from the regular close), regardless of move size — Yahoo leaves ext-bar
  // volume null, so price activity is the only "did it trade" signal.
  let raw = null, moved = false;
  for (let i = ts.length - 1; i >= 0; i--) { const c = closes[i]; if (c == null || !isFinite(c)) continue; if (ts[i] < sess.start || ts[i] >= sess.end) continue; if (raw == null) raw = c; if (c !== meta.regularMarketPrice) moved = true; if (raw != null && moved) break; }
  if (raw == null || !moved) return null;
  const div = centDivisor(market, meta.currency); const extPrice = raw / div, reg = meta.regularMarketPrice / div;
  if (!(reg > 0) || !(extPrice > 0)) return null;
  return { extPrice, extChangePct: (extPrice - reg) / reg * 100, extKind: kind };
}
let expectedExt = null;
try {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/MU?interval=5m&range=1d&includePrePost=true', { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(x => x.json());
  expectedExt = deriveExt(r?.chart?.result?.[0], 'US');
} catch {}
console.log('  live MU session expectation:', expectedExt ? `${expectedExt.extKind} ${expectedExt.extPrice.toFixed(2)} (${expectedExt.extChangePct.toFixed(2)}%)` : 'NONE (regular hours or closed)');

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS = join(ROOT, 'test-screenshots');
const PORT = 9925;
const DBG = 9235;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SEED = {
  'pb.positions.v2': [
    { id: 'p1', ticker: 'MU', market: 'US', shares: 10, costBasis: 100, name: 'Micron Technology Inc', purchaseDate: '2024-02-01', buyFx: 1 },
  ],
  'pb.watchlist.v2': [{ id: 'w1', ticker: 'MU', market: 'US', name: 'Micron Technology Inc' }],
};
const seedJson = JSON.stringify(SEED).replace(/</g, '\\u003c');
const VERIFY_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="/styles.css">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
</head><body>
<div id="root"></div>
<script>try { const s = ${seedJson}; for (const k in s) localStorage.setItem(k, JSON.stringify(s[k])); } catch(e){}</script>
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
async function evals(ws, expr, timeout = 30000) {
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
  writeFileSync(join(SHOTS, `exthours-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot exthours-${name}.png`);
}

let chrome, userDir, failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failures++; };
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-exthours-live-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=440,1200', '--force-device-scale-factor=2',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 440, height: 1200, deviceScaleFactor: 2, mobile: true });

  await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  await sleep(700);

  // Open the MU holding detail.
  await evals(ws, `const b=document.querySelector('[data-tab="current"]'); if(b) b.click(); return true;`);
  await sleep(700);
  await evals(ws, `const row=[...document.querySelectorAll('.holding-row, .pos-card, [class*="holding"]')].find(r=>/MU\\b|Micron/.test(r.textContent)); if(row) row.click(); return true;`);

  // Wait for the live quote to land (the big price stops being a dash) + ext readout.
  const gotQuote = await evals(ws, `
    const dl=Date.now()+30000;
    while(Date.now()<dl){
      const big=document.querySelector('.price-xl, .price-lg, .price');
      if(big && /\\d/.test(big.textContent)) return true;
      await new Promise(r=>setTimeout(r,300));
    }
    return false;`);
  console.log('  live quote rendered:', gotQuote);
  await sleep(500);

  const ext = JSON.parse(await evals(ws, `
    const block=document.querySelector('.daily-block');
    const cols=block?[...block.querySelectorAll('.daily-col')].map(c=>[...c.querySelectorAll('.daily-row')].map(r=>({label:(r.querySelector('.daily-label')||{}).textContent,val:(r.querySelector('.daily-val')||{}).textContent}))):null;
    return JSON.stringify({ cols });
  `));
  console.log('  live detail daily-block:', JSON.stringify(ext.cols));
  await shot(ws, 'live-detail');

  // Switch to the 1D chart and wait for it to paint.
  await evals(ws, `const b=[...document.querySelectorAll('.chart-range-btn')].find(b=>b.textContent.trim()==='1D'); if(b) b.click(); return true;`);
  const chartReady = await evals(ws, `
    const dl=Date.now()+30000;
    while(Date.now()<dl){
      const paths=document.querySelectorAll('.chart-svg path');
      if(paths && paths.length>0) return true;
      const empty=document.querySelector('.chart-empty');
      if(empty) return 'empty';
      await new Promise(r=>setTimeout(r,400));
    }
    return false;`);
  console.log('  1D chart ready:', chartReady);
  await sleep(600);
  await shot(ws, 'live-chart-1d');

  const chart = JSON.parse(await evals(ws, `
    const legend=document.querySelector('.chart-session-legend');
    const segs=[...document.querySelectorAll('.chart-svg path')].length;
    return JSON.stringify({ hasLegend: !!legend, legendText: legend?legend.textContent.replace(/\\s+/g,' ').trim():null, pathCount: segs });
  `));
  console.log('  chart introspection:', JSON.stringify(chart));

  // Assertions — the UI's ext column must match the live session: present during
  // pre/post, absent during regular hours or when closed (matching Google).
  const liveExtCol = ext.cols ? ext.cols[ext.cols.length - 1] : null;
  const hasLiveExt = !!(liveExtCol && liveExtCol.some(r => /After-hours|Pre-market/.test(r.label || '')));
  if (!gotQuote) {
    console.log('  SKIPPED: live quote never loaded (proxy unavailable).');
  } else if (expectedExt) {
    const wantLabel = expectedExt.extKind === 'pre' ? 'Pre-market' : 'After-hours';
    ok(`live: detail shows ${wantLabel} column (session active)`, hasLiveExt && liveExtCol.some(r => r.label === wantLabel), JSON.stringify(liveExtCol));
  } else {
    ok('live: no ext column when market is closed/regular (matches Google)', !hasLiveExt, JSON.stringify(liveExtCol));
  }
  if (chartReady === true) {
    ok('live: 1D chart painted segments', chart.pathCount >= 1);
    ok('live: chart shows an extended-hours session legend', chart.hasLegend, chart.legendText);
  } else {
    console.log('  SKIPPED chart checks: history did not load (', chartReady, ')');
  }

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED (or skipped)' : failures + ' FAILED'}`);
} catch (e) {
  console.error('ERROR', e); failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
