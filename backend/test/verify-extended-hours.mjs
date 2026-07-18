// Real-browser verification of the extended-hours (pre/post market) readout.
// Goal: it should read like Google Finance — the live pre/post PRICE plus its
// move vs the regular close as "+%  ·  +cash" (e.g. Micron after close:
// "After hours 1 235,00 +23,62 (1,95%)") — both in the detail card and the
// inline list chip.
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

const SEED = {
  'pb.positions.v2': [
    { id: 'p1', ticker: 'MU', market: 'US', shares: 10, costBasis: 100, name: 'Micron Technology Inc', purchaseDate: '2024-02-01', buyFx: 1 },
  ],
  'pb.watchlist.v2': [
    { id: 'w1', ticker: 'MU', market: 'US', name: 'Micron Technology Inc' },
    { id: 'w2', ticker: 'TSLA', market: 'US', name: 'Tesla Inc.' },
    { id: 'w3', ticker: 'NVDA', market: 'US', name: 'NVIDIA Corporation' },
  ],
  'pb.prices.v1': { 'US:MU': MU, 'US:TSLA': TSLA, 'US:NVDA': NVDA },
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
async function evals(ws, expr, timeout = 20000) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
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
  await evals(ws, `const b=document.querySelector('[data-tab="watchlist"]'); if(b) b.click(); return true;`);
  await sleep(800);
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
  ok('watchlist: MU chip shows +% and +cash like Google', !!muChip && /\+1\.93%/.test(muChip.chg) && /\+\$23\.42/.test(muChip.chg), muChip && muChip.chg);
  ok('watchlist: MU chip colored green (up)', !!muChip && /\bup\b/.test(muChip.chgClass));
  ok('watchlist: TSLA shows Pre-market label', !!tslaChip, tslaChip && tslaChip.label);
  ok('watchlist: TSLA pre-market is red (down) with -cash', !!tslaChip && /\bdown\b/.test(tslaChip.chgClass) && /-\$6\.82/.test(tslaChip.chg), tslaChip && (tslaChip.chg + ' / ' + tslaChip.chgClass));
  // FINAL (extLive:false) reading survives the session's end as "After close".
  const nvdaChip = chips.find(c => c.price && c.price.includes('194.13'));
  ok('watchlist: NVDA final reading shows After close label', !!nvdaChip && nvdaChip.label === 'After close', nvdaChip && nvdaChip.label);
  ok('watchlist: NVDA final chip carries ext-closed styling', !!nvdaChip && /\bext-closed\b/.test(nvdaChip.cls || ''), nvdaChip && nvdaChip.cls);
  ok('watchlist: NVDA final chip shows +2.10% and +$3.99', !!nvdaChip && /\+2\.10%/.test(nvdaChip.chg) && /\+\$3\.99/.test(nvdaChip.chg), nvdaChip && nvdaChip.chg);
  ok('watchlist: NVDA final move still colored green (up)', !!nvdaChip && /\bup\b/.test(nvdaChip.chgClass));

  // ── 2. DETAIL CARD (showDailyRow) ───────────────────────────────────────────
  await evals(ws, `const b=document.querySelector('[data-tab="current"]'); if(b) b.click(); return true;`);
  await sleep(700);
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
