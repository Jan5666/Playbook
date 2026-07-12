// scratchpad/inc8-picks-render.mjs - run once from repo root; NOT committed.
// Opens the Hot tab (rename regression) and the Picks tab, asserting each renders from pb-views.js.
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');                       // scratchpad/ is one level under repo root
const PORT = 9932, DBG = 9242;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const VERIFY_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css"></head><body>
<div id="root"></div>
<script>
  window.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
</script>
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
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await cdp(ws, 'Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, timeout });
      if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
      return r.result.value;
    } catch (e) { last = e; if (!/context was destroyed|Cannot find context/i.test(String(e.message))) throw e; await sleep(500); }
  }
  throw last;
}

let chrome, userDir, failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  - ' + extra : ''}`); if (!cond) failures++; };
try {
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-picks-'));
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

  const mounted = await evals(ws, `const dl=Date.now()+12000; while(Date.now()<dl){ const r=document.querySelector('#root'); if(r&&r.children.length>0) return true; await new Promise(r=>setTimeout(r,100)); } return false;`);
  ok('app mounts', mounted === true);

  // Both views registered as globals; the bridge grew by PriceBlock + fmt.
  const registered = await evals(ws, `return typeof window.PBViews?.HotTopicsView === 'function' && typeof window.PBViews?.PicksView === 'function' && typeof window.PBApp?.PriceBlock !== 'undefined' && typeof window.PBApp?.fmt !== 'undefined';`);
  ok('PBViews.{HotTopicsView,PicksView} registered & PBApp grown (PriceBlock+fmt)', registered === true);

  // Hot tab still renders after the rename (regression guard).
  await evals(ws, `document.querySelector('button[data-tab="hot"]')?.click(); return true;`);
  await sleep(900);
  const hotOk = await evals(ws, `return !!document.querySelector('.hot-view');`);
  ok('Hot tab still renders after rename (.hot-view)', hotOk === true);

  // Picks tab renders (the new extraction). The nav renders every tab button in the DOM.
  const opened = await evals(ws, `const b=document.querySelector('button[data-tab="picks"]'); if(!b) return false; b.click(); return true;`);
  ok('picks tab nav button exists & clickable', opened === true);
  await sleep(1000);
  const cards = await evals(ws, `return document.querySelectorAll('main .pos-card').length;`);
  ok('Picks tab renders the .pos-card grid (extracted PicksView mounted)', cards >= 1, 'cards=' + cards);
  // Encoding sanity: the moved middot between name and sector renders without mojibake.
  const nameSector = await evals(ws, `return document.querySelector('main .pos-card .tkr-name')?.textContent || '';`);
  ok('moved copy renders intact (no U+FFFD replacement char)', nameSector.length > 0 && nameSector.indexOf(String.fromCharCode(0xFFFD)) === -1, JSON.stringify(nameSector));

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) { console.error('ERROR', e); failures++; }
finally { try { chrome && chrome.kill(); } catch {} try { server.close(); } catch {} process.exit(failures === 0 ? 0 : 1); }
