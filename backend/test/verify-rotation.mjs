// Real-browser verification of the Rotation tab. The node suites never load
// pb-views.js in a DOM, so everything below is only observable here.
//
// The headline assertion is the colour contract: a percentage's tone must come
// from its own sign, never from the slot it sits in. The seed is built so both
// failure directions are present at once —
//   • Technology sells off across the board, so the sector's BEST name is still
//     negative. That chip used to carry a hardcoded 'up' class and render green.
//   • Energy rallies across the board, so the sector's WORST name is positive.
//     That chip used to be hardcoded 'down' and render red.
// The sweep at the end is universe-wide: ANY element in the tab showing a
// minus-signed number in emerald fails the run, so a future regression anywhere
// in this view is caught, not just at the two known sites.
//
// Runs fully offline: window.fetch rejects, and pb.rotation.lastgood.v1 is
// seeded with a snapshot built through the real PBCore pipeline.
// Run: node backend/test/verify-rotation.mjs
//   PB_REACT_DIR=/path/to/umd  serves React locally instead of the unpkg CDN,
//   for sandboxes with no route to unpkg (the other harnesses hardcode the CDN).
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import PBCore from '../../pb-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS = join(ROOT, 'test-screenshots');
const PORT = 9931;
const DBG = 9241;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REACT_DIR = process.env.PB_REACT_DIR || '';

// ── Seed: a rotation day with both colour-trap directions present ────────────
const ROWS = [
  // Broad Technology selloff: AAPL is the sector's best name and still negative.
  { ticker: 'AAPL', sector: 'Technology', m: 3600, changePct: -0.42 },
  { ticker: 'MSFT', sector: 'Technology', m: 3400, changePct: -1.80 },
  { ticker: 'NVDA', sector: 'Technology', m: 3300, changePct: -2.60 },
  // Broad Energy rally: COP is the sector's worst name and still positive.
  { ticker: 'XOM', sector: 'Energy', m: 550, changePct: 3.10 },
  { ticker: 'CVX', sector: 'Energy', m: 300, changePct: 1.90 },
  { ticker: 'COP', sector: 'Energy', m: 140, changePct: 0.85 },
  // Mixed sector: chips straddle zero.
  { ticker: 'JPM', sector: 'Financial Services', m: 800, changePct: 1.20 },
  { ticker: 'BAC', sector: 'Financial Services', m: 340, changePct: -0.60 },
  // Single name -> must be flagged thin rather than presented as a sector.
  { ticker: 'PLD', sector: 'Real Estate', m: 110, changePct: 0.40 },
];
const snapshot = PBCore.aggregateSectorSnapshot(ROWS);
const classified = PBCore.classifyRotation(snapshot);
const flows = PBCore.pairFlows(snapshot.sectors);

// Intraday bars spanning pre / regular / post so regularClose differs from the
// final print — the value the right-edge labels must report.
const DAY = Date.UTC(2026, 6, 30, 0, 0, 0);
const rStart = DAY + 13.5 * 3600000, rEnd = DAY + 20 * 3600000;
const mkBars = (prevClose, pre, open, close, post) => ({
  prevClose, regularStart: rStart, regularEnd: rEnd,
  points: [
    { t: rStart - 1800000, p: pre, v: 1000, session: 'pre' },
    { t: rStart + 600000, p: open, v: 90000, session: 'regular' },
    { t: rEnd - 600000, p: close, v: 80000, session: 'regular' },
    { t: rEnd + 1800000, p: post, v: 5000, session: 'post' },
  ],
});
const plan = { mode: 'stocks', legs: [
  { key: 'Technology', weight: 10300, names: 31, covered: 0.72, proxy: null, symbols: [{ ticker: 'AAPL', market: 'US', w: 3600 }] },
  { key: 'Energy', weight: 990, names: 8, covered: 0.81, proxy: null, symbols: [{ ticker: 'XOM', market: 'US', w: 550 }] },
  { key: 'Financial Services', weight: 1140, names: 22, covered: 0.68, proxy: null, symbols: [{ ticker: 'JPM', market: 'US', w: 800 }] },
] };
const bars = {
  'US:AAPL': mkBars(100, 99.9, 99.4, 99.58, 98.4),  // regular close -0.42%, post -1.60%
  'US:XOM': mkBars(100, 100.2, 101.8, 103.1, 104.0),
  'US:JPM': mkBars(100, 100.1, 100.7, 101.2, 101.0),
};
const series = PBCore.downsampleRotationSeries(PBCore.combineSectorSeries(plan, bars), 48);
// ── Second seed: the widest thing this tab can render (Part C) ──────────────
// A full 11-sector JSE Top 40 day — the longest GICS names, an index label long
// enough to matter in the sr-table's <caption>, R-denominated billions, and both
// sides deep enough to fold into "Others (N)". Part C measures against this
// because the overflow it pins scaled with exactly those strings.
const JSE_ROWS = [
  { ticker: 'NPN', sector: 'Consumer Cyclical', m: 1240, changePct: -2.94 },
  { ticker: 'PRX', sector: 'Consumer Cyclical', m: 980, changePct: -1.85 },
  { ticker: 'FSR', sector: 'Financial Services', m: 420, changePct: -1.20 },
  { ticker: 'SBK', sector: 'Financial Services', m: 380, changePct: -0.75 },
  { ticker: 'CPI', sector: 'Financial Services', m: 210, changePct: -0.44 },
  { ticker: 'SOL', sector: 'Energy', m: 160, changePct: -1.55 },
  { ticker: 'BVT', sector: 'Industrials', m: 190, changePct: -0.92 },
  { ticker: 'BID', sector: 'Industrials', m: 175, changePct: -0.31 },
  { ticker: 'APN', sector: 'Healthcare', m: 105, changePct: -0.68 },
  { ticker: 'NTC', sector: 'Healthcare', m: 95, changePct: -0.22 },
  { ticker: 'AGL', sector: 'Basic Materials', m: 890, changePct: 3.40 },
  { ticker: 'BHG', sector: 'Basic Materials', m: 760, changePct: 2.10 },
  { ticker: 'GFI', sector: 'Basic Materials', m: 540, changePct: 1.75 },
  { ticker: 'MTN', sector: 'Communication Services', m: 610, changePct: 2.85 },
  { ticker: 'VOD', sector: 'Communication Services', m: 430, changePct: 1.40 },
  { ticker: 'GRT', sector: 'Real Estate', m: 120, changePct: 0.95 },
  { ticker: 'RDF', sector: 'Real Estate', m: 88, changePct: 0.51 },
  { ticker: 'SHP', sector: 'Consumer Defensive', m: 310, changePct: 1.15 },
  { ticker: 'BTI', sector: 'Consumer Defensive', m: 295, changePct: 0.63 },
  { ticker: 'TKG', sector: 'Utilities', m: 70, changePct: 0.44 },
  { ticker: 'KIO', sector: 'Technology', m: 240, changePct: 0.88 },
];
const jseSnapshot = PBCore.aggregateSectorSnapshot(JSE_ROWS);
const jseClassified = PBCore.classifyRotation(jseSnapshot);
const jseFlows = PBCore.pairFlows(jseSnapshot.sectors);

// Three market days back, so the "Previous session" treatment must engage.
const FETCHED_AT = Date.now() - 3 * 86400000;
const SEED = {
  'pb.rotation.exchange.v1': 'sp500',
  'pb.rotation.lastgood.v1': {
    sp500: { snapshot, classified, flows, series, activity: series.activity, fetchedAt: FETCHED_AT },
    jse40: { snapshot: jseSnapshot, classified: jseClassified, flows: jseFlows, series: null, activity: null, fetchedAt: FETCHED_AT },
  },
};

const seedJson = JSON.stringify(SEED).replace(/</g, '\\u003c');
const reactTags = REACT_DIR
  ? `<script src="/__react/react.production.min.js"></script>
<script src="/__react/react-dom.production.min.js"></script>`
  : `<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>`;
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
${reactTags}
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
// no-store on everything: without it Chrome may heuristically reuse a response
// from an earlier run of this harness, and you end up asserting against the
// previous build of pb-views.js while the file on disk says otherwise.
const NOSTORE = { 'cache-control': 'no-store, must-revalidate' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/__verify.html') { res.writeHead(200, Object.assign({ 'content-type': 'text/html' }, NOSTORE)); return res.end(VERIFY_HTML); }
  if (p === '/sw.js') { res.writeHead(404); return res.end('no sw'); }
  if (REACT_DIR && p.startsWith('/__react/')) {
    const rf = normalize(join(REACT_DIR, p.slice('/__react/'.length)));
    if (!existsSync(rf)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(readFileSync(rf));
  }
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
// See the note in verify-refresh-behavior.mjs: Chrome destroys the about:blank
// execution context exactly when the harness URL commits, and we attach in that
// window, so this retry is structural rather than a flake workaround. Only the
// transient CDP error is retried; a page exception is a real failure.
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
  writeFileSync(join(SHOTS, `rotation-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot rotation-${name}.png`);
}
// Any minus sign the UI can emit (it renders U+2212, not ASCII hyphen).
const isNegativeText = (t) => /[-\u2212]\s*\d/.test(String(t || ''));
const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(String(s || '')); return m ? m[1].split(',').slice(0, 3).map(x => Math.round(parseFloat(x))).join(',') : null; };
const EMERALD = '16,185,129', ROSE = '244,63,94'; // dark-theme --emerald / --rose

let chrome, userDir, pass = true;
const check = (label, ok) => { console.log((ok ? '  PASS: ' : '  FAIL: ') + label); if (!ok) pass = false; };
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-rotation-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=440,1400', '--force-device-scale-factor=2',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 440, height: 1400, deviceScaleFactor: 2, mobile: true });

  const mounted = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  check('app mounted', mounted);
  // The branded boot loader is a full-screen overlay with a 2.5s cold-start
  // floor. Assertions read the DOM underneath it either way, but the
  // screenshots are worthless until it retires, so wait it out.
  const booted = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ if(!document.querySelector('.pb-loader')) return true; await new Promise(r=>setTimeout(r,150)); } return false;`);
  check('boot loader retired', booted);

  const opened = await evals(ws, `
    const b=[...document.querySelectorAll('.nav-btn')].find(x=>x.textContent.trim()==='Rotation');
    if(!b) return false; b.click(); return true;`);
  check('opened the Rotation tab', opened);
  await sleep(1200);

  const rendered = await evals(ws, `return !!document.querySelector('.rot-verdict-card');`);
  check('verdict card rendered from the seeded snapshot', rendered);

  // ── The regression: tone must follow the value's sign ──────────────────────
  const chips = JSON.parse(await evals(ws, `
    return JSON.stringify([...document.querySelectorAll('.rot-tkr-chip')].map(el => ({
      text: el.textContent.trim(), cls: el.className, color: getComputedStyle(el).color })));`));
  console.log('  ticker chips:', chips.map(c => c.text + ' [' + c.cls.replace('rot-tkr-chip ', '') + ']').join(' | '));
  check('ticker chips rendered', chips.length >= 6);

  const aapl = chips.find(c => /AAPL/.test(c.text));
  check('sector-best AAPL chip is present', !!aapl);
  check('sector-best AAPL shows a negative number', !!aapl && isNegativeText(aapl.text));
  check('sector-best-but-negative is NOT green', !!aapl && rgb(aapl.color) !== EMERALD);
  check('sector-best-but-negative is red', !!aapl && rgb(aapl.color) === ROSE);

  const cop = chips.find(c => /COP/.test(c.text));
  check('sector-worst COP chip is present', !!cop);
  check('sector-worst COP shows a positive number', !!cop && !isNegativeText(cop.text));
  check('sector-worst-but-positive is NOT red', !!cop && rgb(cop.color) !== ROSE);
  check('sector-worst-but-positive is green', !!cop && rgb(cop.color) === EMERALD);

  // Universe-wide sweep: no negative number anywhere in the tab may be emerald,
  // and no positive number may be rose. Catches future regressions at any site.
  const violations = JSON.parse(await evals(ws, `
    const out=[];
    const walk=document.createTreeWalker(document.querySelector('.rot-view'), NodeFilter.SHOW_ELEMENT);
    const seen=new Set();
    while (walk.nextNode()) {
      const el=walk.currentNode;
      // leaf-ish only: elements whose own text is a single number token
      if (el.children.length>1) continue;
      const t=(el.textContent||'').trim();
      if (!/^[+\\u2212-]?\\s*[\\u25b2\\u25bc]?\\s*[A-Z.]*\\s*[+\\u2212-]?[\\d.,]+\\s*(%|bp|bn|tn|pp)?$/.test(t)) continue;
      if (seen.has(t+el.className)) continue; seen.add(t+el.className);
      const col=getComputedStyle(el).color;
      const m=/rgba?\\(([^)]+)\\)/.exec(col);
      const key=m?m[1].split(',').slice(0,3).map(x=>Math.round(parseFloat(x))).join(','):null;
      const neg=/[-\\u2212]\\s*[\\d.]/.test(t);
      const pos=/^\\+/.test(t);
      if (neg && key==='16,185,129') out.push({t, cls:el.className, col, why:'negative in emerald'});
      if (pos && key==='244,63,94') out.push({t, cls:el.className, col, why:'positive in rose'});
    }
    return JSON.stringify(out);`));
  if (violations.length) console.log('  violations:', JSON.stringify(violations, null, 1));
  check('no sign/colour mismatch anywhere in the rotation view', violations.length === 0);

  // ── Accuracy surfacing ─────────────────────────────────────────────────────
  const info = JSON.parse(await evals(ws, `
    const txt=s=>{const e=document.querySelector(s);return e?e.textContent.trim():null;};
    return JSON.stringify({
      phase: txt('.rot-phase-chip'),
      head: txt('.rot-head-val'),
      headCls: (document.querySelector('.rot-head-val')||{}).className,
      verdict: txt('.rot-verdict-pill'),
      thin: document.querySelectorAll('.rot-thin-tag').length,
      cov: [...document.querySelectorAll('.rot-cov-chip')].map(e=>e.textContent.trim()),
      coverage: txt('.rot-coverage'),
      ribbons: document.querySelectorAll('.rot-flow-ribbon').length,
      grid: document.querySelectorAll('.rot-grid').length,
      extLines: document.querySelectorAll('.rot-line-ext').length,
      valLbls: [...document.querySelectorAll('.rot-val-lbl')].map(e=>e.textContent.trim()),
      act: document.querySelectorAll('.rot-act').length,
      srRows: document.querySelectorAll('.rot-sr tbody tr').length,
      updated: txt('.rot-updated'),
      stats: [...document.querySelectorAll('.rot-stat-label')].map(e=>e.textContent.trim())
    });`));
  console.log('  view:', JSON.stringify(info, null, 1));
  check('stale cache renders as "Previous session"', info.phase === 'Previous session');
  check('stale timestamp uses relative age, not a bare clock time', /ago/.test(info.updated || ''));
  check('headline shows the market move', isNegativeText(info.head || ''));
  check('headline is toned down (red)', /\bdown\b/.test(info.headCls || ''));
  check('verdict is outflow-with-rotation', info.verdict === 'Outflows, with rotation underneath');
  check('single-name sector flagged thin', info.thin === 1);
  check('per-sector chart coverage chips rendered', info.cov.length >= 3 && /of \d+ names/.test(info.cov[0]));
  check('universe coverage line rendered', /of 9 names quoted/.test(info.coverage || '') && /87% of index cap/.test(info.coverage || ''));
  check('flow ribbons rendered and interactive', info.ribbons >= 3);
  check('chart has y gridlines', info.grid >= 2);
  check('extended-hours tail drawn separately', info.extLines >= 2);
  check('dollar-volume activity bars rendered', info.act >= 3);
  check('screen-reader table mirrors the sectors', info.srRows === 4);
  check('stat tiles include participation + dispersion', info.stats.includes('Participation') && info.stats.includes('Dispersion'));

  // Right-edge labels must report the REGULAR close (AAPL -0.42%), not the
  // post-market print (-1.60%) — that is the chart/list agreement fix.
  check('chart labels report the regular-session close, not the post print',
    info.valLbls.some(t => /0\.42/.test(t)) && !info.valLbls.some(t => /1\.60/.test(t)));
  await shot(ws, 'tab');

  // ── Interactions ───────────────────────────────────────────────────────────
  const cross = await evals(ws, `
    const svg=document.querySelector('.rot-chart-svg'); if(!svg) return 'no-svg';
    const r=svg.getBoundingClientRect();
    svg.dispatchEvent(new PointerEvent('pointermove',{clientX:r.left+r.width*0.45,clientY:r.top+r.height*0.5,bubbles:true}));
    await new Promise(r=>setTimeout(r,250));
    const c=document.querySelector('.rot-cross-strip');
    return c?c.textContent.trim():'no-card';`);
  console.log('  crosshair readout:', JSON.stringify(cross));
  check('crosshair readout appears on pointer move', cross !== 'no-svg' && cross !== 'no-card' && /Market/.test(cross));

  const gloss = await evals(ws, `
    const b=[...document.querySelectorAll('.rot-stat-head')].find(x=>/Dispersion/.test(x.textContent));
    if(!b) return 'no-btn'; b.click(); await new Promise(r=>setTimeout(r,200));
    const h=document.querySelector('.rot-stat-help');
    return h?h.textContent.trim().slice(0,60):'no-help';`);
  check('stat tiles explain their jargon on tap', gloss !== 'no-btn' && gloss !== 'no-help' && gloss.length > 20);

  const sorted = await evals(ws, `
    const b=[...document.querySelectorAll('.rot-sort-btn')].find(x=>x.textContent.trim()==='Move');
    if(!b) return 'no-btn'; b.click(); await new Promise(r=>setTimeout(r,250));
    const first=document.querySelector('.rot-row .rot-row-title');
    return first?first.textContent.trim():'no-row';`);
  check('sorting by Move puts the best sector first', sorted === 'Energy');

  const isolated = await evals(ws, `
    const row=[...document.querySelectorAll('.rot-row')].find(r=>/Energy/.test(r.textContent));
    if(!row) return -1; row.click(); await new Promise(r=>setTimeout(r,250));
    return document.querySelectorAll('.rot-row.faded').length;`);
  check('tapping a sector row isolates it', isolated >= 1);
  await shot(ws, 'interactions');

  // ── Part C: layout — this tab must never widen the document ───────────────
  // On an installed iOS PWA, ANY horizontal scrollable width lets the user drag
  // the whole app sideways (header, nav and all, with a black gutter behind it):
  // html/body's overflow-x: hidden does not hold there. Chrome clips it properly,
  // so scrollLeft always reads 0 in this harness -- scrollWidth is the honest
  // signal and the one worth pinning.
  //
  // The bug this pins: .rot-sr sat on the <table> itself. A table box cannot
  // shrink below its min-content width, so `width: 1px` was a floor, its
  // `overflow: hidden` clipped only the rows, and the invisible 403px box drove
  // documentElement.scrollWidth to 429 at every viewport below that.
  const switched = await evals(ws, `
    const b=[...document.querySelectorAll('.heatmap-toggle-btn')].find(x=>/JSE Top 40/.test(x.textContent));
    if(!b) return 'no-chip'; b.click(); await new Promise(r=>setTimeout(r,900));
    return document.querySelector('.rot-verdict-card') ? 'ok' : 'no-card';`);
  check('switched to the wide JSE seed', switched === 'ok');

  // Anti-drift: the visually-hidden class must stay on a wrapper, not the table.
  check('screen-reader table is wrapped in a div, not classed itself',
    await evals(ws, `return !!document.querySelector('div.rot-sr > table') && !document.querySelector('table.rot-sr');`));
  check('screen-reader mirror still carries every sector',
    (await evals(ws, `return document.querySelectorAll('.rot-sr tbody tr').length;`)) === 11);

  for (const width of [320, 375, 402, 430]) {
    await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width, height: 1400, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    const m = JSON.parse(await evals(ws, `
      window.scrollTo(0, 0); await new Promise(r=>setTimeout(r,60));
      const de=document.documentElement, vw=de.clientWidth, sw=de.scrollWidth;
      const off=[];
      // Only worth enumerating when it actually overflowed, and only for elements
      // NOTHING clips: the .nav and .heatmap-toggle chips always sit past the edge
      // inside their own overflow-x: auto strip and scroll internally, so listing
      // them buries the one element that really widened the page.
      // Stop below <body>: html/body DO carry overflow-x: hidden, and that rule
      // is the very one that leaks on iOS, so counting it here would filter out
      // every offender and print an empty list next to a failing assertion.
      const clipped = el => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== 'visible') return true;
        }
        return false;
      };
      if (sw > vw + 1) document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (!(r.width || r.height) || r.right <= vw + 0.5 || clipped(el)) return;
        const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || ''));
        off.push({ label: el.tagName + '.' + cls.trim() + ' @' + Math.round(r.right), right: r.right });
      });
      off.sort((a, b) => b.right - a.right);
      return JSON.stringify({ vw, sw, off: off.slice(0, 8).map(o => o.label) });`));
    if (m.off && m.off.length) console.log('  past the right edge:', m.off.join(' | '));
    check(`no horizontal page overflow at ${width}px (scrollWidth ${m.sw} vs viewport ${m.vw})`, m.sw <= m.vw + 1);
  }
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 402, height: 1400, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  await shot(ws, 'layout-402');

  ws.close();
  console.log(pass ? '\nRESULT: all checks PASSED' : '\nRESULT: some checks FAILED');
} catch (e) {
  console.error('ERROR', e); pass = false;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
}
process.exit(pass ? 0 : 1);
