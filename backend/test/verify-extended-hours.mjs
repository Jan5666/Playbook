// Real-browser verification of the extended-hours (pre/post market) readout, in
// its three homes:
//   1. the watchlist card chip — live pre/post PRICE + the % vs the regular close.
//      The cash delta ("· +$23.42") was dropped here at Jan's request (2026-07-28);
//      the card is a glance surface. Only the DETAIL card still carries it.
//   2. the Holdings "view pre-market moves" toggle — the Today column reports the
//      ext move instead, symbols with no reading show a dim dash, and the Pre/post
//      sort appears only while the toggle is on.
//   3. the detail card (showDailyRow) — still Google-style "+%  ·  +cash".
//   Run: node backend/test/verify-extended-hours.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS = join(ROOT, 'test-screenshots');
const PORT = 9924;
const DBG = 9234;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Micron, mirroring the user's reference screenshot. Regular session closed at
// 1211.38 (+6.82%); after-hours trading at 1234.80 (+23.42 / +1.93% vs close).
const MU = {
  price: 1211.38, change: 77.39, changePct: 6.82, prevClose: 1133.99,
  yearHigh: 1213.56, yearLow: 103.38, currency: 'USD',
  extPrice: 1234.80, extChange: 23.42, extChangePct: 1.93, extKind: 'post',
  marketState: 'POST', fetchedAt: Date.now(),
};
// A pre-market name too, to confirm the "Pre-market" label / down move path.
const TSLA = {
  price: 412.0, change: 6.0, changePct: 1.48, prevClose: 406.0,
  currency: 'USD',
  extPrice: 405.18, extChange: -6.82, extChangePct: -1.66, extKind: 'pre',
  marketState: 'PRE', fetchedAt: Date.now(),
};
// A FINAL (session-over) after-hours reading — the overnight "move after the
// close" that must stay visible once the post session has ended. extLive:false
// switches the label to "After close" and applies the muted ext-closed styling.
const NVDA = {
  price: 190.14, change: 2.31, changePct: 1.23, prevClose: 187.83,
  currency: 'USD',
  extPrice: 194.13, extChange: 3.99, extChangePct: 2.10, extKind: 'post',
  extLive: false, extAsOf: Date.now() - 10 * 3600 * 1000,
  marketState: 'CLOSED', fetchedAt: Date.now(),
};

// No ext fields at all — the "no pre/post reading" case the Holdings pre-market
// column has to render as a dim dash rather than falling back to the day's move.
const KO = {
  price: 62.40, change: 0.31, changePct: 0.50, prevClose: 62.09,
  currency: 'USD', marketState: 'CLOSED', fetchedAt: Date.now(),
};

const SEED = {
  'pb.positions.v2': [
    { id: 'p1', ticker: 'MU', market: 'US', shares: 10, costBasis: 100, name: 'Micron Technology Inc', purchaseDate: '2024-02-01', buyFx: 1 },
    { id: 'p2', ticker: 'KO', market: 'US', shares: 20, costBasis: 50, name: 'Coca-Cola Co', purchaseDate: '2024-03-01', buyFx: 1 },
  ],
  'pb.watchlist.v2': [
    { id: 'w1', ticker: 'MU', market: 'US', name: 'Micron Technology Inc' },
    { id: 'w2', ticker: 'TSLA', market: 'US', name: 'Tesla Inc.' },
    { id: 'w3', ticker: 'NVDA', market: 'US', name: 'NVIDIA Corporation' },
  ],
  'pb.prices.v1': { 'US:MU': MU, 'US:TSLA': TSLA, 'US:NVDA': NVDA, 'US:KO': KO },
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
  // Block network so the seeded quotes (with ext fields) are what render.
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
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(SHOTS, `exthours-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot exthours-${name}.png`);
}

let chrome, userDir, failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failures++; };
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-exthours-'));
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

  // The first eval races the page's initial navigation — if devtools attaches
  // while Chrome is still swapping from about:blank to the verify page, the
  // in-flight eval dies with "Execution context was destroyed". Retry it: the
  // navigation only happens once, so a later attempt lands on the real page.
  let mounted = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      mounted = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
      break;
    } catch (e) {
      if (!/Execution context was destroyed|Cannot find context/.test(String(e && e.message))) throw e;
      await sleep(400);
    }
  }
  console.log('  app mounted:', mounted);
  await sleep(700);

  // ── 1. WATCHLIST inline chip ────────────────────────────────────────────────
  // Poll for the cards rather than sleeping a fixed 800ms: on a slow or loaded
  // machine the app can still be booting when the tab is clicked, and every
  // assertion below then fails against an empty list — a false red that looks
  // exactly like a real regression. Re-clicks the tab each turn because the first
  // click can land before the nav exists.
  const wlReady = await evals(ws, `
    const dl=Date.now()+20000;
    while(Date.now()<dl){
      const b=document.querySelector('[data-tab="watchlist"]'); if(b) b.click();
      if(document.querySelector('.watchlist-list .ext-hours')) return 'ready';
      await new Promise(r=>setTimeout(r,200));
    }
    return 'timeout';`);
  console.log('  watchlist ready:', wlReady);
  await sleep(300);
  await shot(ws, 'watchlist');
  const chips = JSON.parse(await evals(ws, `
    const out=[];
    for (const el of document.querySelectorAll('.ext-hours')) {
      const label=el.querySelector('.ext-label'); const price=el.querySelector('.ext-price'); const chg=el.querySelector('.ext-chg');
      out.push({ label: label?label.textContent.trim():null, price: price?price.textContent.trim():null,
                 chg: chg?chg.textContent.trim():null, chgClass: chg?chg.className:null, cls: el.className });
    }
    return JSON.stringify(out);
  `));
  console.log('  inline ext chips:', JSON.stringify(chips));
  const muChip = chips.find(c => c.price && c.price.includes('1,234.80'));
  const tslaChip = chips.find(c => c.label === 'Pre-market');
  ok('watchlist: found ext-hours chips', chips.length >= 2);
  ok('watchlist: MU shows After-hours label', !!muChip && muChip.label === 'After-hours', muChip && muChip.label);
  ok('watchlist: MU shows live ext price $1,234.80', !!muChip && /\$1,234\.80/.test(muChip.price), muChip && muChip.price);
  // The card chip is PRICE + % only. The cash delta ("· +$23.42") was dropped at
  // Jan's request (2026-07-28) — the card is a glance surface, the rand/dollar
  // amount is detail. The DETAIL card below still carries it, so this is the
  // assertion that keeps the two from drifting back together.
  // The chip's move span is now the bare percentage — no currency symbol at all.
  const noCash = (s) => !/[$£€]/.test(String(s || ''));
  ok('watchlist: MU chip shows the %', !!muChip && /\+1\.93%/.test(muChip.chg), muChip && muChip.chg);
  ok('watchlist: MU chip carries NO cash delta', !!muChip && noCash(muChip.chg), muChip && muChip.chg);
  ok('watchlist: MU chip colored green (up)', !!muChip && /\bup\b/.test(muChip.chgClass));
  ok('watchlist: TSLA shows Pre-market label', !!tslaChip, tslaChip && tslaChip.label);
  ok('watchlist: TSLA pre-market is red (down), % only', !!tslaChip && /\bdown\b/.test(tslaChip.chgClass) && /-1\.66%/.test(tslaChip.chg) && !/\$6\.82/.test(tslaChip.chg), tslaChip && (tslaChip.chg + ' / ' + tslaChip.chgClass));
  // FINAL (extLive:false) reading survives the session's end as "After close".
  const nvdaChip = chips.find(c => c.price && c.price.includes('194.13'));
  ok('watchlist: NVDA final reading shows After close label', !!nvdaChip && nvdaChip.label === 'After close', nvdaChip && nvdaChip.label);
  ok('watchlist: NVDA final chip carries ext-closed styling', !!nvdaChip && /\bext-closed\b/.test(nvdaChip.cls || ''), nvdaChip && nvdaChip.cls);
  ok('watchlist: NVDA final chip shows +2.10%, no cash', !!nvdaChip && /\+2\.10%/.test(nvdaChip.chg) && !/\$3\.99/.test(nvdaChip.chg), nvdaChip && nvdaChip.chg);
  ok('watchlist: NVDA final move still colored green (up)', !!nvdaChip && /\bup\b/.test(nvdaChip.chgClass));

  // ── 2. HOLDINGS "view pre-market moves" toggle ──────────────────────────────
  // The Today column swaps to the extended-hours move, the header renames itself,
  // and the Pre/post sort appears — but only while the toggle is on. MU carries a
  // live post reading (+1.93%), KO carries none, so this run covers both branches.
  const hdReady = await evals(ws, `
    const dl=Date.now()+20000;
    while(Date.now()<dl){
      const b=document.querySelector('[data-tab="current"]'); if(b) b.click();
      if(document.querySelector('.holding-row')) return 'ready';
      await new Promise(r=>setTimeout(r,200));
    }
    return 'timeout';`);
  console.log('  holdings ready:', hdReady);
  await sleep(300);
  const readHoldings = `
    const head=document.querySelector('.holding-list-head .hlh-day');
    const rows=[...document.querySelectorAll('.holding-row')].map(r=>{
      const tkr=r.querySelector('.hold-tkr-main'); const chip=r.querySelector('.holding-day');
      const dash=r.querySelector('.holding-day-empty');
      return { tkr: tkr?tkr.textContent.trim():null,
               chip: chip?chip.textContent.trim():null,
               chipCls: chip?chip.className:null,
               dash: dash?dash.textContent.trim():null };
    });
    return JSON.stringify({ dayLabel: head?head.textContent.trim():null, rows });`;
  const sortLabels = `
    const btn=document.querySelector('[aria-label="Sort holdings"]'); if(!btn) return '[]';
    btn.click(); await new Promise(r=>setTimeout(r,250));
    const out=[...document.querySelectorAll('.wl-sortmenu-row .wl-sortmenu-label')].map(e=>e.textContent.trim());
    const back=document.querySelector('.wl-pop-backdrop'); if(back) back.click();
    await new Promise(r=>setTimeout(r,200));
    return JSON.stringify(out);`;

  const hOff = JSON.parse(await evals(ws, readHoldings));
  const sortOff = JSON.parse(await evals(ws, sortLabels));
  console.log('  holdings (toggle off):', JSON.stringify(hOff), '\n  sort options:', JSON.stringify(sortOff));
  ok('holdings: column is "Today" by default', hOff.dayLabel === 'Today', hOff.dayLabel);
  ok('holdings: default chips are the DAY move', (hOff.rows.find(r => r.tkr === 'MU') || {}).chip === '+6.82%', JSON.stringify(hOff.rows.map(r => [r.tkr, r.chip])));
  ok('holdings: Pre/post sort hidden while the toggle is off', !sortOff.includes('Pre/post move'), sortOff.join(' / '));

  const toggled = await evals(ws, `
    const b=document.querySelector('[aria-label="Show pre-market moves"]'); if(!b) return 'no-toggle';
    b.click(); await new Promise(r=>setTimeout(r,400)); return b.getAttribute('aria-pressed');`);
  console.log('  toggle clicked -> aria-pressed:', toggled);
  ok('holdings: pre-market toggle exists and presses on', toggled === 'true', String(toggled));
  await shot(ws, 'holdings-premarket');

  const hOn = JSON.parse(await evals(ws, readHoldings));
  const sortOn = JSON.parse(await evals(ws, sortLabels));
  console.log('  holdings (toggle on):', JSON.stringify(hOn), '\n  sort options:', JSON.stringify(sortOn));
  const muRow = hOn.rows.find(r => r.tkr === 'MU') || {};
  const koRow = hOn.rows.find(r => r.tkr === 'KO') || {};
  ok('holdings: column renames to "Pre-mkt"', hOn.dayLabel === 'Pre-mkt', hOn.dayLabel);
  ok('holdings: MU chip switches to the ext move +1.93%', muRow.chip === '+1.93%', muRow.chip);
  ok('holdings: MU chip carries the is-ext ring', /\bis-ext\b/.test(muRow.chipCls || ''), muRow.chipCls);
  ok('holdings: MU chip still colour-coded up', /\btext-up\b/.test(muRow.chipCls || ''), muRow.chipCls);
  ok('holdings: KO (no ext reading) shows a dim dash, not its day move', koRow.chip == null && !!koRow.dash, JSON.stringify(koRow));
  ok('holdings: Pre/post sort appears while the toggle is on', sortOn.includes('Pre/post move'), sortOn.join(' / '));

  // Back off again: the column reverts and the sort option is withdrawn.
  const untoggled = await evals(ws, `
    const b=document.querySelector('[aria-label="Show pre-market moves"]');
    b.click(); await new Promise(r=>setTimeout(r,400)); return b.getAttribute('aria-pressed');`);
  const hBack = JSON.parse(await evals(ws, readHoldings));
  ok('holdings: toggling back off restores the day move', untoggled === 'false' && hBack.dayLabel === 'Today' && (hBack.rows.find(r => r.tkr === 'MU') || {}).chip === '+6.82%',
     untoggled + ' / ' + hBack.dayLabel);

  // ── 3. DETAIL CARD (showDailyRow) ───────────────────────────────────────────
  await sleep(300);
  const openedDetail = await evals(ws, `
    const row=[...document.querySelectorAll('.holding-row, .pos-card, [class*="holding"]')].find(r=>/MU\\b|Micron/.test(r.textContent));
    if(!row) return 'no-row'; row.click(); return 'clicked';`);
  console.log('  open MU detail:', openedDetail);
  await sleep(900);
  await shot(ws, 'detail');
  const card = JSON.parse(await evals(ws, `
    const block=document.querySelector('.daily-block'); if(!block) return JSON.stringify({found:false});
    const cols=[...block.querySelectorAll('.daily-col')].map(col=>{
      return [...col.querySelectorAll('.daily-row')].map(r=>{
        const lab=r.querySelector('.daily-label'); const val=r.querySelector('.daily-val');
        return { label: lab?lab.textContent.trim():null, val: val?val.textContent.trim():null, valClass: val?val.className:null };
      });
    });
    return JSON.stringify({ found:true, cols });
  `));
  console.log('  detail daily-block:', JSON.stringify(card, null, 2));
  ok('detail: daily-block present', card.found);
  const extCol = card.found ? card.cols[card.cols.length - 1] : [];
  const extPriceRow = extCol.find(r => /1,234\.80/.test(r.val || ''));
  const extMoveRow = extCol.find(r => /%/.test(r.val || ''));
  ok('detail: ext column labelled After-hours', extCol.some(r => r.label === 'After-hours'), JSON.stringify(extCol.map(r => r.label)));
  ok('detail: ext column shows live price $1,234.80', !!extPriceRow, extPriceRow && extPriceRow.val);
  ok('detail: ext column shows move "+1.93% · +$23.42"', !!extMoveRow && /\+1\.93%/.test(extMoveRow.val) && /\+\$23\.42/.test(extMoveRow.val), extMoveRow && extMoveRow.val);
  ok('detail: ext move colored green (up)', !!extMoveRow && /\bup\b/.test(extMoveRow.valClass));

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) {
  console.error('ERROR', e); failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
