// Verifies the header refresh control: status folded into the refresh button
// (colored dot), a quick tap refreshes, and press-and-hold "peeks" a pill with
// the relative-time text WITHOUT refreshing. Network is mocked.
//   Run: node backend/test/verify-refresh-peek.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const PORT = 9928;
const DBG = 9238;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SEED = {
  'pb.positions.v2': [
    { id: 'p1', ticker: 'AAPL', market: 'US', shares: 12, costBasis: 150, name: 'Apple Inc.', purchaseDate: '2024-02-01', buyFx: 1 },
  ],
};
const seedJson = JSON.stringify(SEED).replace(/</g, '\\u003c');

const VERIFY_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="/styles.css">
</head><body>
<div id="root"></div>
<script>
  try { const s = ${seedJson}; for (const k in s) localStorage.setItem(k, JSON.stringify(s[k])); } catch(e){}
  window.__log = [];
  function quoteJSON(sym){ return JSON.stringify({ chart: { result: [ { meta: {
    regularMarketPrice: 200, chartPreviousClose: 190, regularMarketPreviousClose: 190,
    previousClose: 190, currency: 'USD', regularMarketTime: Math.floor(Date.now()/1000),
    shortName: sym, marketState: 'REGULAR' } } ] } }); }
  window.fetch = async (u) => {
    const s = String(u || ''); let inner = null;
    try { inner = new URL(s).searchParams.get('url'); } catch (e) {}
    if (inner && inner.includes('/v8/finance/chart/')) {
      let sym=''; try { sym = decodeURIComponent(inner.split('/chart/')[1].split('?')[0]); } catch(e){}
      window.__log.push({ sym, t: performance.now() });
      return new Response(quoteJSON(sym), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
</script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="/pb-core.js"></script>
<script src="/pb-data.js"></script>
<script src="/pb-store.js"></script>
<script src="/pb-content.js"></script>
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

let chrome, userDir, failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failures++; };
try {
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-peek-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=440,1100',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__verify.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch(`http://localhost:${DBG}/json`)).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
  await sleep(900);

  const mounted = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('.refresh-btn'); if(r) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  ok('refresh control mounted', mounted === true);

  // Structure: old chip gone, new control + dot present.
  ok('standalone .status-chip removed', (await evals(ws, `return document.querySelectorAll('.status-chip').length;`)) === 0);
  ok('.refresh-dot present on the button', (await evals(ws, `return !!document.querySelector('.refresh-btn .refresh-dot');`)) === true);

  // Let the first sweep land so status reads "live".
  const dotLive = await evals(ws, `const dl=Date.now()+8000; while(Date.now()<dl){ const d=document.querySelector('.refresh-dot'); if(d && /\\blive\\b/.test(d.className)) return true; await new Promise(r=>setTimeout(r,150)); } return false;`);
  ok('status dot reads live after first sweep', dotLive === true, await evals(ws, `return document.querySelector('.refresh-dot')?.className;`));

  // TAP (native click) refreshes.
  await evals(ws, `window.__log = []; return true;`);
  await evals(ws, `const b=document.querySelector('.refresh-btn'); b.click(); return true;`);
  await sleep(1500);
  ok('a quick tap (click) issues a fresh sweep', (await evals(ws, `return window.__log.length;`)) > 0);

  // HOLD peeks WITHOUT refreshing.
  await evals(ws, `
    window.__log = [];
    const b=document.querySelector('.refresh-btn'); const r=b.getBoundingClientRect();
    window.__cx=r.left+r.width/2; window.__cy=r.top+r.height/2;
    b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,clientX:window.__cx,clientY:window.__cy,button:0}));
    return true;`);
  await sleep(330);
  ok('holding expands the peek pill', (await evals(ws, `return !!document.querySelector('.refresh-ctl.peeking');`)) === true);
  const peekText = await evals(ws, `return document.querySelector('.refresh-peek-text')?.textContent || '';`);
  ok('peek shows relative-time/status text', /ago|just now|Updating|Updated|Loading/i.test(peekText), JSON.stringify(peekText));
  ok('holding alone does NOT refresh', (await evals(ws, `return window.__log.length;`)) === 0);

  // RELEASE collapses, and the trailing click is suppressed (no refresh).
  await evals(ws, `
    const b=document.querySelector('.refresh-btn');
    b.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,clientX:window.__cx,clientY:window.__cy,button:0}));
    b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return true;`);
  await sleep(80);
  ok('releasing collapses the peek', (await evals(ws, `return !document.querySelector('.refresh-ctl.peeking');`)) === true);
  ok('release after a peek does NOT refresh (click suppressed)', (await evals(ws, `return window.__log.length;`)) === 0);

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) {
  console.error('ERROR', e); failures++;
} finally {
  try { chrome && chrome.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}
