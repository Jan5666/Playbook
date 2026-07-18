// Real-browser verification of the watchlist suggestion strip:
//  - "Hot right now" cluster from the cached hot-stocks feed, with the live
//    day-move badge on each chip
//  - already-held (positions) and already-watched symbols never suggested
//  - "For you" cluster includes a recently-searched symbol (pb.searchHist.v1)
//  - tapping a hot chip adds it to the watchlist (chip morphs to the green tick)
// Run: node backend/test/verify-watchlist-suggestions.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS = join(ROOT, 'test-screenshots');
const PORT = 9931;
const DBG = 9241;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const NOW = Date.now();
const SEED = {
  // NVDA is HELD, MU is WATCHED — both appear in the hot feed below and must
  // be filtered out of the suggestions.
  'pb.positions.v2': [
    { id: 'p1', ticker: 'NVDA', market: 'US', shares: 5, costBasis: 120, name: 'NVIDIA Corporation', purchaseDate: '2025-01-02', buyFx: 1 },
  ],
  'pb.watchlist.v2': [
    { id: 'w1', ticker: 'MU', market: 'US', name: 'Micron Technology Inc' },
  ],
  // NVDA (the held position) must carry a cached price so the boot splash takes
  // the warm-start path and clears at MIN_COLD_MS instead of the 8s failsafe.
  'pb.prices.v1': {
    'US:MU': { price: 1211.38, change: 77.39, changePct: 6.82, prevClose: 1133.99, currency: 'USD', fetchedAt: NOW },
    'US:NVDA': { price: 190.14, change: 2.31, changePct: 1.23, prevClose: 187.83, currency: 'USD', fetchedAt: NOW },
  },
  // Recently-searched symbol that is neither held nor watched nor curated →
  // must surface in the "For you" cluster purely from search history.
  'pb.searchHist.v1': [
    { t: 'RDDT', m: 'US', n: 'Reddit Inc', at: NOW - 3600 * 1000 },
  ],
  // Fresh hot-stocks cache (TTL 10min) so the strip renders without network.
  'pb.hotStocks.v1': {
    fetchedAt: NOW,
    items: [
      { ticker: 'NVDA', market: 'US', name: 'NVIDIA Corporation', changePct: 5.1, hotScore: 6 },   // held → excluded
      { ticker: 'MU', market: 'US', name: 'Micron Technology Inc', changePct: 6.8, hotScore: 5.5 }, // watched → excluded
      { ticker: 'SMCI', market: 'US', name: 'Super Micro Computer', changePct: 12.34, hotScore: 5 },
      { ticker: 'IONQ', market: 'US', name: 'IonQ Inc', changePct: -3.21, hotScore: 4 },
      { ticker: 'BTC', market: 'CRYPTO', name: 'Bitcoin', changePct: 4.4, hotScore: 3 },
    ],
  },
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
async function evals(ws, expr, timeout = 20000) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
}
async function shot(ws, name) {
  const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(SHOTS, `wl-suggest-${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  shot wl-suggest-${name}.png`);
}

let chrome, userDir, failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failures++; };
try {
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-wlsug-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=440,1300', '--force-device-scale-factor=2',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 440, height: 1300, deviceScaleFactor: 2, mobile: true });

  // First eval can race the initial navigation ("Execution context was
  // destroyed") — retry, the navigation only happens once.
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
  // Sit out the branded boot splash (MIN_COLD_MS = 2.5s on a cold open) so the
  // screenshots show the actual view, not the loader.
  await sleep(3200);

  await evals(ws, `const b=document.querySelector('[data-tab="watchlist"]'); if(b) b.click(); return true;`);
  await sleep(800);
  await shot(ws, 'strip');

  const strip = JSON.parse(await evals(ws, `
    const subs = [...document.querySelectorAll('.sug-sub')].map(el => el.textContent.trim());
    const chips = [...document.querySelectorAll('.chip-row .chip')].map(el => ({
      cls: el.className,
      txt: el.textContent.replace(/\\s+/g, ' ').trim(),
      pct: el.querySelector('.chip-pct') ? el.querySelector('.chip-pct').textContent.trim() : null,
      pctCls: el.querySelector('.chip-pct') ? el.querySelector('.chip-pct').className : null,
    }));
    const flame = !!document.querySelector('.sug-sub .sug-sub-flame');
    return JSON.stringify({ subs, chips, flame });
  `));
  console.log('  strip:', JSON.stringify(strip.subs), 'chips:', strip.chips.length);
  const hotChips = strip.chips.filter(c => /\bchip-hot\b/.test(c.cls));
  const plainChips = strip.chips.filter(c => !/\bchip-hot\b/.test(c.cls) && !/\badded\b/.test(c.cls));
  ok('sub-headers "Hot right now" + "For you" render', strip.subs.some(s => /hot right now/i.test(s)) && strip.subs.some(s => /for you/i.test(s)), JSON.stringify(strip.subs));
  ok('flame icon renders in the hot header', strip.flame);
  ok('hot cluster has chips', hotChips.length >= 2, String(hotChips.length));
  ok('held symbol (NVDA position) is NOT suggested', !strip.chips.some(c => /\bNVDA\b/.test(c.txt)));
  ok('watched symbol (MU) is NOT suggested', !strip.chips.some(c => /\bMU\b/.test(c.txt)));
  const smci = hotChips.find(c => /SMCI/.test(c.txt));
  const ionq = hotChips.find(c => /IONQ/.test(c.txt));
  ok('SMCI hot chip shows its up day-move', !!smci && smci.pct === '+12.3%' && /\bup\b/.test(smci.pctCls || ''), smci && (smci.pct + ' / ' + smci.pctCls));
  ok('IONQ hot chip shows its down day-move', !!ionq && ionq.pct === '-3.2%' && /\bdown\b/.test(ionq.pctCls || ''), ionq && ionq.pct);
  ok('recently-searched RDDT surfaces in "For you"', plainChips.some(c => /^RDDT/.test(c.txt)), plainChips.slice(0, 5).map(c => c.txt.split(' ')[0]).join(','));

  // Tap the SMCI hot chip → green "Added" confirmation + a new watchlist card.
  const tapped = await evals(ws, `
    const chip = [...document.querySelectorAll('.chip.chip-hot')].find(el => /SMCI/.test(el.textContent));
    if (!chip) return 'no-chip'; chip.click(); return 'clicked';
  `);
  console.log('  tap SMCI:', tapped);
  // Check the DOM before screenshotting: the green tick chip lives ~1.7s and a
  // hi-dpi captureBeyondViewport shot can eat most of that window.
  await sleep(300);
  const after = JSON.parse(await evals(ws, `
    const added = [...document.querySelectorAll('.chip.added')].map(el => el.textContent.replace(/\\s+/g, ' ').trim());
    const cards = [...document.querySelectorAll('.watchlist-list .pos-card .tkr')].map(el => el.textContent.trim());
    const stored = JSON.parse(localStorage.getItem('pb.watchlist.v2') || '[]').map(w => w.ticker);
    return JSON.stringify({ added, cards, stored });
  `));
  console.log('  after tap:', JSON.stringify(after));
  await shot(ws, 'added');
  ok('tapped chip morphs into the green Added tick', after.added.some(t => /SMCI/.test(t)), JSON.stringify(after.added));
  ok('SMCI card appears in the watchlist', after.cards.includes('SMCI'), JSON.stringify(after.cards));
  ok('SMCI persisted to pb.watchlist.v2', after.stored.includes('SMCI'), JSON.stringify(after.stored));

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) {
  console.error('ERROR', e); failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
