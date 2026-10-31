// Real-browser verification of Preview mode (headless Chrome via CDP): seeds a
// REAL book, flips pb.previewMode.v1 on via the store, and proves the demo book
// (window.PB_DEMO) is shown while the real localStorage stays byte-identical —
// then flips it off and proves the real book returns.
//
// Part B (2026-10-31) pins the ways preview "didn't always work":
//   - the demo book must get priced even while a real-book sweep is in flight
//     (network here HANGS rather than failing, so the boot sweep stays active —
//     the auto-poll refresh on the universe change used to no-op behind it);
//   - real alerts / trigger history / TFSA targets + contribution never render;
//   - TFSA "Equal weight" and a watchlist drag-reorder never write the real store;
//   - opening the Watchlist tab never resets the real selected list;
//   - with no demo dataset loaded, the "Preview" pill never sits over the real book.
//   Run: node backend/test/verify-preview-mode.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const PORT = 9931;
const DBG = 9241;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// The REAL book: one distinctive ticker that never appears in the demo set
// (KO is not among the 16 demo instruments; AAPL/MSFT/etc. are).
const SEED = {
  'pb.positions.v2': [
    { id: 'real1', ticker: 'KO', market: 'US', shares: 12, costBasis: 55, name: 'Coca-Cola Company', purchaseDate: '2024-02-01' },
  ],
  'pb.alerts.v2': [
    { id: 'ra1', ticker: 'KO', market: 'US', direction: 'above', targetPrice: 99.5, note: 'REALALERTNOTE', active: true, createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  'pb.triggered.v2': [
    { id: 'rt1', alertId: 'ra0', ticker: 'KO', market: 'US', direction: 'above', targetPrice: 60, price: 61, note: 'REALTRIGNOTE', triggeredAt: new Date().toISOString() },
  ],
  'pb.tfsa.targets.v1': { REALETF: '100' },
  'pb.tfsa.contribution.v1': '7777',
  'pb.watchlist.v2': [
    { id: 'rw1', ticker: 'PEP', market: 'US', name: 'PepsiCo REALWATCH', listIds: ['grp-real'], addedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'rw2', ticker: 'MCD', market: 'US', name: 'McDonald REALWATCH', listIds: ['default'], addedAt: '2026-01-01T00:00:00.000Z' },
  ],
  'pb.watchlistGroups.v1': [{ id: 'grp-real', name: 'Real list' }],
  'pb.watchlist.activeList.v1': 'grp-real',
  'pb.prices.v1': {
    'US:KO': { price: 62, change: 0.4, changePct: 0.65, prevClose: 61.6, currency: 'USD', fetchedAt: Date.now() },
    'US:NVDA': { price: 170, change: 2.0, changePct: 1.19, prevClose: 168.0, currency: 'USD', fetchedAt: Date.now() },
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
  // External requests are RECORDED and never answered -- only the app's own 8 s
  // abort ends them, exactly as on a real stalled network. That keeps the boot
  // sweep in flight, which is the condition preview used to break under.
  const realFetch = window.fetch;
  window.__reqs = [];
  window.fetch = (u, o) => { const s = String(u || ''); if (s.startsWith('http')) { window.__reqs.push(s); const sig = o && o.signal; return new Promise((_, rej) => { if (sig) sig.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); }); } return realFetch(u, o); };
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
<script src="/demo-data.js"></script>
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

let chrome, userDir, failures = 0;
const ok = (l, c, d) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); } };

try {
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-verify-preview-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=440,900',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  for (let i = 0; i < 50; i++) { if (await evals(ws, `return !!document.querySelector('.nav')`)) break; await sleep(200); }

  const realLsBefore = await evals(ws, `return localStorage.getItem('pb.positions.v2');`);
  const LS_KEYS = ['pb.watchlist.v2', 'pb.watchlistGroups.v1', 'pb.watchlist.activeList.v1', 'pb.alerts.v2',
    'pb.triggered.v2', 'pb.tfsa.targets.v1', 'pb.tfsa.contribution.v1', 'pb.sectorWeights.v1'];
  const snap = () => evals(ws, `return JSON.stringify(${JSON.stringify(LS_KEYS)}.map(k => [k, localStorage.getItem(k)]));`);
  const lsSnapBefore = await snap();
  ok('real alerts: bell shows the real alert count before preview',
    await evals(ws, `return !!document.querySelector('[aria-label="Alerts"] .badge');`));

  // 1. Real book shows before preview.
  await evals(ws, `document.querySelector('[data-tab="current"]').click(); return true;`);
  await sleep(400);
  const realText = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('real book: KO visible before preview', /Coca-Cola/.test(realText));
  ok('real book: no demo ticker before preview', !/NVIDIA/.test(realText));
  ok('no header badge before preview', await evals(ws, `return !document.querySelector('.preview-badge');`));

  // 2. Preview on → demo book + badge; real book hidden.
  await evals(ws, `PBStore.setSetting('previewMode', true); return true;`);
  await sleep(600);
  const prevText = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('preview: demo ticker (NVDA/NVIDIA) visible', /NVDA|NVIDIA/.test(prevText));
  const leak = await evals(ws, `
    const hits = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && /Coca-Cola|(^|[^A-Z])KO([^A-Z]|$)/.test(e.textContent || ''));
    return JSON.stringify(hits.slice(0, 5).map(e => (e.className || e.tagName) + ' :: ' + (e.textContent || '').slice(0, 60)));
  `);
  ok('preview: real ticker hidden', !/Coca-Cola/.test(prevText), leak);
  ok('preview: header badge shows', await evals(ws, `return !!document.querySelector('.preview-badge');`));

  // 3. Real localStorage untouched by the swap.
  const realLsAfter = await evals(ws, `return localStorage.getItem('pb.positions.v2');`);
  ok('preview: pb.positions.v2 byte-identical', realLsAfter === realLsBefore);
  ok('preview: no demo rows leaked into storage', !/demo-/.test(realLsAfter || ''));

  // ── Part B ────────────────────────────────────────────────────────────────
  // B1. The demo book gets fetched although the boot sweep is still hanging. The
  //     superseded sweep's requests still hold the shared pLimit(8) slots until
  //     their 8 s deadline, so allow one deadline plus slack -- the old behaviour
  //     was to wait for the WHOLE real sweep (6 proxies x 8 s per symbol).
  let demoFetched = false;
  for (let i = 0; i < 70 && !demoFetched; i++) {
    // NVDA is pre-seeded with a price above, so prioritizeSweep rightly fetches it
    // late; the unpriced demo names are the ones the user is staring at. (Proxied
    // URLs carry the Yahoo URL encoded, hence the decode.)
    demoFetched = await evals(ws, `return window.__reqs.some(u => /chart\\/(MSFT|AAPL|TSLA|AMZN)\\?/.test(decodeURIComponent(u)));`);
    if (!demoFetched) await sleep(200);
  }
  ok('B1 preview: demo symbols fetched while a real sweep is in flight', demoFetched,
    await evals(ws, `return window.__reqs.length + ' reqs, none for an unpriced demo symbol';`));

  // B2. Real alerts / trigger history never render.
  ok('B2 preview: bell shows no real alert/trigger badge',
    await evals(ws, `return !document.querySelector('[aria-label="Alerts"] .badge');`));
  await evals(ws, `document.querySelector('[aria-label="Alerts"]').click(); return true;`);
  await sleep(400);
  const alertsText = await evals(ws, `const m = document.querySelector('.modal'); return m ? m.textContent : '';`);
  ok('B2 preview: alerts sheet hides the real alert + history',
    !/REALALERTNOTE|REALTRIGNOTE|99\.5/.test(alertsText), alertsText.slice(0, 160));
  await evals(ws, `const b = document.querySelector('.modal-backdrop'); if (b) b.click(); return true;`);
  await sleep(500);

  // B3. TFSA planner: real contribution hidden; "Equal weight" writes nothing real.
  await evals(ws, `document.querySelector('[data-tab="tfsa"]').click(); return true;`);
  await sleep(500);
  await evals(ws, `const h = [...document.querySelectorAll('.collapse-head')].find(b => /Contribution planner/.test(b.textContent)); if (h && h.getAttribute('aria-expanded') !== 'true') h.click(); return true;`);
  await sleep(400);
  const tfsaContrib = await evals(ws, `const i = document.querySelector('.tfsa-contrib input'); return i ? i.value : '(no input)';`);
  ok('B3 preview: real TFSA contribution not shown', tfsaContrib !== '7777', 'input value ' + tfsaContrib);
  const eq = await evals(ws, `const b = [...document.querySelectorAll('.tfsa-preset-btn')].find(b => /Equal weight/.test(b.textContent)); if (b) b.click(); return !!b;`);
  await sleep(300);
  ok('B3 preview: Equal weight button reachable', eq);
  ok('B3 preview: Equal weight leaves real pb.tfsa.targets.v1 untouched',
    (await evals(ws, `return localStorage.getItem('pb.tfsa.targets.v1');`)) === JSON.stringify(SEED['pb.tfsa.targets.v1']));

  // B4. Watchlist: demo list shows (not filtered to an empty real custom list),
  //     the real active list survives, and a drag-reorder writes nothing.
  await evals(ws, `document.querySelector('[data-tab="watchlist"]').click(); return true;`);
  await sleep(600);
  const wlText = await evals(ws, `return document.querySelector('main').textContent;`);
  ok('B4 preview: demo watchlist visible', /PLTR|Palantir/.test(wlText), wlText.slice(0, 120));
  ok('B4 preview: real watchlist hidden', !/REALWATCH/.test(wlText));
  ok('B4 preview: real selected list not reset',
    (await evals(ws, `return localStorage.getItem('pb.watchlist.activeList.v1');`)) === JSON.stringify('grp-real'));
  const cards = await evals(ws, `return JSON.stringify([...document.querySelectorAll('.swipe-card-outer')].filter(e => e.getBoundingClientRect().height > 30).slice(0, 3).map(e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.height]; }));`);
  const pts = JSON.parse(cards);
  if (pts.length >= 2) {
    const [x, y, h] = pts[0];
    await cdp(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(900);
    for (let k = 1; k <= 10; k++) {
      await cdp(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y + (h * 1.6) * k / 10, button: 'left', buttons: 1 });
      await sleep(30);
    }
    await cdp(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: y + h * 1.6, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(500);
  }
  ok('B4 preview: watchlist drag-reorder attempted on demo cards', pts.length >= 2, cards);

  // B5. Nothing real moved during all of the above.
  const lsSnapPreview = await snap();
  ok('B5 preview: watchlist/alerts/TFSA/sector-weight keys byte-identical', lsSnapPreview === lsSnapBefore,
    lsSnapPreview);

  // 4. Preview off → real book returns instantly.
  await evals(ws, `document.querySelector('[data-tab="current"]').click(); return true;`);
  await sleep(400);
  await evals(ws, `PBStore.setSetting('previewMode', false); return true;`);
  await sleep(600);
  const backText = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('off: real book returns', /Coca-Cola/.test(backText));
  ok('off: demo book gone', !/NVIDIA/.test(backText));
  ok('off: badge gone', await evals(ws, `return !document.querySelector('.preview-badge');`));
  ok('off: real alert badge returns',
    await evals(ws, `return !!document.querySelector('[aria-label="Alerts"] .badge');`));

  // B6. Demo dataset missing (stale cached index.html, or demo-data.js failed to
  //     load): the pill must never sit over the real book. Simulated by hiding
  //     PB_DEMO and blocking the self-heal's script injection.
  await evals(ws, `document.querySelector('[data-tab="current"]').click();
    window.__demoBackup = window.PB_DEMO; delete window.PB_DEMO;
    const s = document.createElement('script'); s.setAttribute('data-pb-demo', '1'); document.head.appendChild(s);
    PBStore.setSetting('previewMode', true); return true;`);
  await sleep(600);
  const noDemoText = await evals(ws, `return document.getElementById('root').textContent;`);
  ok('B6 no dataset: badge shows', await evals(ws, `return !!document.querySelector('.preview-badge');`));
  ok('B6 no dataset: real book NOT shown under the Preview pill', !/Coca-Cola/.test(noDemoText));
  await evals(ws, `PBStore.setSetting('previewMode', false); window.PB_DEMO = window.__demoBackup; return true;`);
  await sleep(600);
  ok('B6 off again: real book returns', /Coca-Cola/.test(await evals(ws, `return document.getElementById('root').textContent;`)));
  ok('end: watchlist/alerts/TFSA keys still byte-identical', (await snap()) === lsSnapBefore);
} catch (e) {
  failures++;
  console.error('FATAL', e);
} finally {
  try { chrome?.kill(); } catch {}
  server.close();
}
console.log(failures ? `\n❌ ${failures} CHECK(S) FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
