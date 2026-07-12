// Verifies the macro/market-indicator feature end-to-end in headless Chrome
// against the EXACT shipped app.js, using the same inert-harness + CDP pattern
// as ee-ocr-image.mjs (globals defined, no #root so the app never auto-mounts).
//
//   Part A — live data layer: calls the real fetchQuote / fetchHistory / GLI /
//            VIX-mood paths (FRED + Yahoo via the app's CORS proxies) and sanity
//            -checks the returned quotes & chart series.
//   Part B — rendering: mounts the real <DetailModal> for an indicator with the
//            live data, screenshots it, and confirms the explanation card, unit
//            -formatted value and price-trigger form rendered. Also mounts <Hero>
//            and asserts a ribbon pill click fires onOpenDetail.
//
// Run: node backend/test/verify-indicators.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const PORT = 9917;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const HARNESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ind-harness</title>
<link rel="stylesheet" href="/styles.css"></head><body>
<div id="test"></div>
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
</body></html>`; // no #root → app.js mount throws after globals are defined → inert page

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/__harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HARNESS_HTML); }
  if (p === '/sw.js') { res.writeHead(404); return res.end('no sw'); }
  const f = normalize(join(ROOT, p));
  if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[f.slice(f.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream' }); res.end(readFileSync(f));
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function cdp(ws, method, params = {}, id = Math.floor(Math.random() * 1e9)) {
  return new Promise((resolve, reject) => {
    const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
    ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalAsync(ws, expr, timeout = 120000) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}

let chrome, userDir, failures = 0;
const ok = (l, c, d) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${d !== undefined ? ' — ' + d : ''}`); } };

try {
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'ind-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--remote-debugging-port=9227', `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__harness.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch('http://localhost:9227/json')).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });

  // Wait for app.js globals.
  const ready = await evalAsync(ws, `const dl=Date.now()+12000; while(Date.now()<dl && (typeof fetchQuote!=='function'||typeof DetailModal!=='function')){await new Promise(r=>setTimeout(r,100));} return typeof fetchQuote==='function' && typeof DetailModal==='function' && typeof RIBBON_CATALOG!=='undefined';`, 20000);
  ok('app.js globals available on inert harness', ready);
  if (!ready) throw new Error('globals never came up');

  // ── Part A: live data layer ───────────────────────────────────────────────
  console.log('\nPart A — live data layer (FRED + Yahoo via app proxies):');
  const a = await evalAsync(ws, `
    const out = {};
    const grab = async (label, fn) => { try { out[label] = await fn(); } catch(e){ out[label] = { __err: String(e&&e.message||e) }; } };
    await Promise.all([
      grab('tnx',  () => fetchQuote('^TNX','US')),
      grab('cpi',  () => fetchQuote('CPI','MACRO')),
      grab('nfp',  () => fetchQuote('NFP','MACRO')),
      grab('ff',   () => fetchQuote('FEDFUNDS','MACRO')),
      grab('gli',  () => fetchQuote('GLI','MACRO')),
      grab('fng',  () => fetchQuote('FNG','MACRO')),
    ]);
    const hist = {};
    const gh = async (label, t, m, r) => { try { const h = await fetchHistory(t,m,r); hist[label] = h ? h.points.length : 0; } catch(e){ hist[label] = -1; } };
    await Promise.all([ gh('cpiH','CPI','MACRO','5y'), gh('gliH','GLI','MACRO','5y'), gh('fngH','FNG','MACRO','1y') ]);
    return { out, hist };
  `, 120000);
  const q = a.out;
  const show = (k) => { const v = q[k]; return v && v.__err ? 'ERR ' + v.__err : (v ? JSON.stringify({ price: v.price, prev: v.prevClose, chg: v.change, asOf: v.asOf, src: v.source }) : 'null'); };
  for (const k of ['tnx','cpi','nfp','ff','gli','fng']) console.log(`  ${k.padEnd(4)}: ${show(k)}`);
  console.log('  history points:', JSON.stringify(a.hist));
  ok('10Y yield quote in 0–15% range', q.tnx && q.tnx.price > 0 && q.tnx.price < 15, q.tnx && q.tnx.price);
  ok('CPI YoY quote in -5–20% range + has asOf', q.cpi && isFinite(q.cpi.price) && Math.abs(q.cpi.price) < 20 && !!q.cpi.asOf, q.cpi && q.cpi.price);
  ok('NFP monthly-change quote finite + has asOf', q.nfp && isFinite(q.nfp.price) && !!q.nfp.asOf, q.nfp && q.nfp.price);
  ok('Fed funds quote in 0–15% range', q.ff && q.ff.price >= 0 && q.ff.price < 15, q.ff && q.ff.price);
  ok('Global Liquidity proxy in 5–40 ($T) range', q.gli && q.gli.price > 5 && q.gli.price < 40, q.gli && q.gli.price);
  ok('Fear & Greed score in 0–100 range', q.fng && q.fng.price >= 0 && q.fng.price <= 100, q.fng && q.fng.price);
  ok('CPI chart series has ≥ 24 points', a.hist.cpiH >= 24, a.hist.cpiH);
  ok('GLI chart series has ≥ 24 points', a.hist.gliH >= 24, a.hist.gliH);
  ok('F&G chart series has ≥ 24 points', a.hist.fngH >= 24, a.hist.fngH);

  // ── Part B: render the real DetailModal for an indicator ───────────────────
  console.log('\nPart B — render <DetailModal> for CPI (live data) + screenshot:');
  const b = await evalAsync(ws, `
    const tk='CPI', mk='MACRO', key=mk+':'+tk;
    const quote = await fetchQuote(tk, mk);
    const hist = await fetchHistory(tk, mk, '5y');
    const prices = { [key]: quote };
    const historyByTicker = { [key+':5y']: { data: hist, loading: false } };
    let addedAlert = null;
    const props = {
      selected: { ticker: tk, market: mk },
      prices, positions: [], watchlist: [], watchlistGroups: [],
      alerts: [], news: null, historyByTicker, fundamentals: null, fxRates: null,
      onClose: ()=>{}, onAddWatch: null, onRemoveWatch: ()=>{}, onMoveWatch: ()=>{},
      onAddWatchGroup: ()=>{}, onAddAlert: (...args)=>{ addedAlert = args; }, onRemoveAlert: ()=>{},
      onLoadNews: ()=>{}, onLoadHistory: ()=>{}
    };
    const el = document.getElementById('test');
    const root = ReactDOM.createRoot(el);
    root.render(React.createElement(DetailModal, props));
    await new Promise(r=>setTimeout(r, 600));
    const txt = document.body.innerText;
    // open the price-trigger form and submit a target to confirm the path works
    window.__addedAlert = () => addedAlert;
    return {
      hasAbout: /What is .*CPI/i.test(txt),
      hasInterpret: /How to read it/i.test(txt),
      hasPctValue: /%/.test((document.querySelector('.price-xl')||{}).textContent||''),
      priceText: (document.querySelector('.price-xl')||{}).textContent || '',
      hasChart: !!document.querySelector('.chart-svg, .chart-skeleton, .chart-empty'),
      chartReady: !!document.querySelector('.chart-svg'),
      rangeBtns: Array.from(document.querySelectorAll('.chart-range-btn')).map(b=>b.textContent),
      noFundamentals: !/Market cap|P\\/E ratio/i.test(txt),
      title: (document.querySelector('.modal-title')||{}).textContent || ''
    };
  `, 120000);
  console.log('  price-xl text :', JSON.stringify(b.priceText));
  console.log('  title         :', JSON.stringify(b.title));
  console.log('  chart ranges  :', JSON.stringify(b.rangeBtns));
  ok('explanation card "What is … CPI" present', b.hasAbout);
  ok('"How to read it" section present', b.hasInterpret);
  ok('value formatted as % (not $)', b.hasPctValue && !/\$/.test(b.priceText), b.priceText);
  ok('chart rendered', b.hasChart);
  ok('chart range bar restricted to macro windows (no 1D/1W)', !b.rangeBtns.includes('1D') && !b.rangeBtns.includes('1W'), JSON.stringify(b.rangeBtns));
  ok('no stock fundamentals on indicator card', b.noFundamentals);
  ok('title shows indicator short (CPI)', /CPI/i.test(b.title), b.title);

  // Clean screenshot of the indicator card (explanation + chart, no popup).
  {
    const shot0 = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
    const out0 = join(tmpdir(), 'indicator-cpi-card-clean.png');
    writeFileSync(out0, Buffer.from(shot0.data, 'base64'));
    console.log('  clean card screenshot →', out0);
  }

  // Submit a price trigger through the real form.
  console.log('\n  price-trigger form:');
  const c = await evalAsync(ws, `
    const bell = document.querySelector('.detail-alert-bell');
    if (bell) bell.click();
    await new Promise(r=>setTimeout(r, 250));
    const input = document.querySelector('.alert-target-input');
    const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    if (input){ setVal.call(input,'3.5'); input.dispatchEvent(new Event('input',{bubbles:true})); }
    await new Promise(r=>setTimeout(r, 150));
    const submit = document.querySelector('.alert-submit');
    const submitText = submit ? submit.textContent : '';
    if (submit) submit.click();
    await new Promise(r=>setTimeout(r, 150));
    return { hadInput: !!input, submitText, added: window.__addedAlert ? window.__addedAlert() : null };
  `, 30000);
  console.log('  submit label  :', JSON.stringify(c.submitText));
  console.log('  onAddAlert args:', JSON.stringify(c.added));
  ok('alert form opened with target input', c.hadInput);
  ok('submit label shows % unit (e.g. "above 3.50%")', /%/.test(c.submitText) && !/\$/.test(c.submitText), c.submitText);
  ok('onAddAlert fired with target 3.5 on MACRO:CPI', Array.isArray(c.added) && c.added[0] === 'CPI' && c.added[1] === 'MACRO' && Math.abs(c.added[3] - 3.5) < 1e-6, JSON.stringify(c.added));

  // Screenshot the rendered indicator card (with the trigger popup open).
  const shot = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
  const outPng = join(tmpdir(), 'indicator-cpi-card.png');
  writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
  console.log('  screenshot saved →', outPng);

  // Render the Fear & Greed card too (score unit + level chips) and screenshot.
  console.log('\n  Fear & Greed card (score unit):');
  const fg = await evalAsync(ws, `
    const tk='FNG', mk='MACRO', key=mk+':'+tk;
    const quote = await fetchQuote(tk, mk);
    const hist = await fetchHistory(tk, mk, '1y');
    const props = {
      selected: { ticker: tk, market: mk },
      prices: { [key]: quote }, positions: [], watchlist: [], watchlistGroups: [],
      alerts: [], news: null, historyByTicker: { [key+':1y']: { data: hist, loading: false } },
      fundamentals: null, fxRates: null, onClose: ()=>{}, onAddWatch: null, onRemoveWatch: ()=>{},
      onMoveWatch: ()=>{}, onAddWatchGroup: ()=>{}, onAddAlert: ()=>{}, onRemoveAlert: ()=>{},
      onLoadNews: ()=>{}, onLoadHistory: ()=>{}
    };
    ReactDOM.createRoot(document.getElementById('test')).render(React.createElement(DetailModal, props));
    await new Promise(r=>setTimeout(r, 500));
    return { priceText: (document.querySelector('.price-xl')||{}).textContent||'',
             levels: Array.from(document.querySelectorAll('.indicator-level-label')).map(e=>e.textContent) };
  `, 60000);
  console.log('  F&G value     :', JSON.stringify(fg.priceText), ' levels:', JSON.stringify(fg.levels));
  ok('F&G value is a bare 0–100 score (no %/$)', /^\d{1,3}$/.test(fg.priceText.trim()), fg.priceText);
  ok('F&G shows interpretation level chips', fg.levels.length >= 2, JSON.stringify(fg.levels));
  {
    const shotF = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(tmpdir(), 'indicator-fng-card.png'), Buffer.from(shotF.data, 'base64'));
  }

  // ── Part B2: ribbon pill click fires onOpenDetail ─────────────────────────
  console.log('\nPart B2 — <Hero> ribbon pill is clickable:');
  const d = await evalAsync(ws, `
    let opened = null;
    const items = ['US:^SPX','US:^TNX','MACRO:CPI','MACRO:FNG','US:^DJT'];
    const prices = { 'US:^TNX': { price: 4.45, changePct: 0.3 }, 'MACRO:CPI': { price: 3.1, changePct: 0.0 } };
    const el = document.getElementById('test');
    const root = ReactDOM.createRoot(el);
    root.render(React.createElement(Hero, { prices, ribbonItems: items, ribbonMode: 'rows', onOpenDetail: (t,m)=>{ opened = [t,m]; } }));
    await new Promise(r=>setTimeout(r, 300));
    const pills = Array.from(document.querySelectorAll('.ribbon-pill-tappable'));
    const labels = pills.map(p => (p.querySelector('.ribbon-pill-label')||{}).textContent);
    // click the CPI pill (label "CPI")
    const cpiPill = pills.find(p => (p.querySelector('.ribbon-pill-label')||{}).textContent === 'CPI');
    if (cpiPill) cpiPill.click();
    await new Promise(r=>setTimeout(r, 100));
    return { count: pills.length, labels, opened };
  `, 20000);
  console.log('  pills         :', JSON.stringify(d.labels));
  console.log('  opened on click:', JSON.stringify(d.opened));
  ok('ribbon rendered tappable pills', d.count >= 5, d.count);
  ok('clicking CPI pill fires onOpenDetail("CPI","MACRO")', Array.isArray(d.opened) && d.opened[0] === 'CPI' && d.opened[1] === 'MACRO', JSON.stringify(d.opened));

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
} catch (e) { failures++; console.error('VERIFY ERROR:', e.message); }
finally { try { chrome?.kill(); } catch {} try { server.close(); } catch {} await sleep(300); try { if (userDir) rmSync(userDir, { recursive: true, force: true }); } catch {} process.exit(failures === 0 ? 0 : 1); }
