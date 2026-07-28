// Real-browser verification of the watchlist-card restyle:
//  - stock price top-right, with the day's move stacked directly UNDER it in the
//    header's money column (it used to own a body row of its own, with the left
//    half of that row empty — moving it up takes a whole row off the card)
//  - the money still reads down one right-hand column: price, day's move, 52W high
//  - the alert bell and the 52W badge now share ONE body row, the bell on the left
//    under the company name
//  - the "+$ today" cash line removed from under the % change
// Run: node backend/test/verify-watchlist.mjs
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

const SEED = {
  'pb.watchlist.v2': [
    { id: 'w1', ticker: 'GOOGL', market: 'US', name: 'Alphabet Inc.' },
    { id: 'w2', ticker: 'AAPL', market: 'US', name: 'Apple Inc.' },
    { id: 'w3', ticker: 'TSLA', market: 'US', name: 'Tesla Inc.' },
  ],
  'pb.prices.v1': {
    // price below yearHigh → red "−9.9%" badge; has alert (seeded below) for the count.
    'US:GOOGL': { price: 368.03, change: 4.24, changePct: 1.17, prevClose: 363.79, yearHigh: 408.5, currency: 'USD', fetchedAt: Date.now() },
    'US:AAPL': { price: 232.1, change: -1.8, changePct: -0.77, prevClose: 233.9, yearHigh: 260.1, currency: 'USD', fetchedAt: Date.now() },
    'US:TSLA': { price: 412.0, change: 6.0, changePct: 1.48, prevClose: 406.0, yearHigh: 414.0, currency: 'USD', fetchedAt: Date.now() },
  },
  'pb.alerts.v2': [
    { id: 'a1', ticker: 'GOOGL', market: 'US', kind: 'above', value: 400, active: true },
  ],
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
  writeFileSync(join(SHOTS, `watchlist-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot watchlist-${name}.png`);
}

let chrome, userDir, failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-watch-'));
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
  await sleep(600);

  // Poll for the cards rather than sleeping a fixed 700ms: on a slow or loaded
  // machine the app can still be booting when the tab is clicked, and the probe
  // below then returns "(no card)" — a false red that looks like a real
  // regression. Re-clicks each turn because the first click can land before the
  // nav exists.
  const ready = await evals(ws, `
    const dl=Date.now()+20000;
    while(Date.now()<dl){
      const b=document.querySelector('[data-tab="watchlist"]'); if(b) b.click();
      if(document.querySelector('.watchlist-list .pos-card')) return 'ready';
      await new Promise(r=>setTimeout(r,200));
    }
    return 'timeout';`);
  console.log('  watchlist ready:', ready);
  await sleep(300);
  await shot(ws, 'cards');

  const layout = await evals(ws, `
    const card = document.querySelector('.watchlist-list .pos-card');
    if (!card) return '(no card)';
    const head = card.querySelector('.pos-head');
    const body = card.querySelector('.watch-body');
    const price = card.querySelector('.price-block-wrap');
    const badge = card.querySelector('.ath-badge');
    const bell  = card.querySelector('.card-alert-bell');
    const pct   = card.querySelector('.watch-today-pct');
    const amt   = card.querySelector('.watch-today-amt');
    const inHead = (el) => !!el && head.contains(el);
    const inBody = (el) => !!el && body.contains(el);
    const rb = (el) => el ? el.getBoundingClientRect() : null;
    const cr = card.getBoundingClientRect();
    const out = {
      priceInHead: inHead(price),
      badgeInBody: inBody(badge),
      bellInBody:  inBody(bell),
      // The day's move now rides in the HEADER, stacked under the price — the card
      // used to spend a whole row on it with the left half of that row empty.
      pctInHead:   inHead(pct),
      amtGone:     amt === null,
      badgeText:   badge ? badge.textContent.replace(/\\s+/g,' ').trim() : null,
      pctText:     pct ? pct.textContent.trim() : null,
      cardH:       Math.round(cr.height),
    };
    // Geometry: everything money still reads down ONE right-hand column (price,
    // day's move, 52W high), with the bell alone on the left under the company name.
    if (badge && bell) { out.bellLeftOfBadge = rb(bell).right < rb(badge).left + 1; out.badgeOnRight = rb(badge).right > cr.right - cr.width * 0.45; }
    if (price) out.priceOnRight = rb(price).right > cr.right - cr.width * 0.45;
    if (pct) out.pctOnRight = rb(pct).right > cr.right - cr.width * 0.45;
    // The chip sits directly UNDER the price inside the header's money column…
    if (price && pct) out.pctBelowPrice = rb(pct).top >= rb(price).bottom - 1;
    // …and the 52W badge stays under the chip, one body row further down.
    if (badge && pct) out.badgeBelowPct = rb(badge).top >= rb(pct).bottom - 1;
    // Compare against the CHIP, not the % text inside it: the chip carries its own
    // padding, so the text's right edge is inset from the column the badge tracks.
    const chip = card.querySelector('.watch-today');
    if (badge && chip) out.badgeRightEdgeMatchesChip = Math.abs(rb(badge).right - rb(chip).right) <= 2;
    // Bell and 52W badge now share ONE body row — that collapsed row is the whole
    // point of the change, so pin it.
    if (bell && badge) {
      const mid = (el) => { const r = rb(el); return r.top + r.height / 2; };
      out.bellCentredOnBadge = Math.abs(mid(bell) - mid(badge)) <= 2;
    }
    // The bell starts where the ticker/company name starts, not under the logo.
    const nameEl = card.querySelector('.wl-idtxt');
    if (bell && nameEl) out.bellIndentMatchesName = Math.abs(rb(bell).left - rb(nameEl).left) <= 2;
    return JSON.stringify(out);
  `);
  console.log('  layout:', layout);
  const L = JSON.parse(layout);
  ok('price moved into header (top-right)', L.priceInHead === true);
  ok('52W badge in body', L.badgeInBody === true);
  ok('bell in body', L.bellInBody === true);
  ok('bell sits to the LEFT of the 52W badge', L.bellLeftOfBadge === true);
  ok('52W badge on the right', L.badgeOnRight === true);
  ok('day move moved into the header, under the price', L.pctInHead === true && L.pctBelowPrice === true);
  ok('52W badge still sits underneath the day move', L.badgeBelowPct === true);
  ok('52W badge right edge lines up with the day move', L.badgeRightEdgeMatchesChip === true);
  ok('bell and 52W badge share one body row', L.bellCentredOnBadge === true);
  ok('bell starts where the company name starts', L.bellIndentMatchesName === true);
  ok('price hugs the right of the header', L.priceOnRight === true);
  ok('% change on the right', L.pctOnRight === true);
  ok('"+$ today" amount line removed', L.amtGone === true);
  ok('badge shows 52W Hi value', /52W Hi/i.test(L.badgeText || '') && /%|ATH/.test(L.badgeText || ''));
  // The whole point: one fewer row. Baseline before this change was ~148px at
  // 440x1100; anything at or under 130 means the row really did collapse.
  ok('card lost a row of height (<=130px)', L.cardH > 0 && L.cardH <= 130, L.cardH + 'px');

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) {
  console.error('ERROR', e); failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
