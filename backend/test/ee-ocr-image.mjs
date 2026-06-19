// Image-level OCR verification in headless Chrome, against the EXACT shipped
// pipeline (ocrImageFile → parseEasyEquitiesScreenshot).
//   1. Synthetic gate: an EE-style page (purple title bar + body) — asserts the
//      title-bar pass recovers the FULL name with no amount.
//   2. Real screenshots: every image in test-screenshots/ is run through the same
//      pipeline; its title-bar read + parsed fields + raw OCR are printed.
// The page loaded is an INERT harness (app.js's globals defined, but no #root so
// the app never mounts/polls) — stable across a long multi-image batch.
// Run: node backend/test/ee-ocr-image.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SHOTS_DIR = join(ROOT, 'test-screenshots');
const PORT = 9915;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const HARNESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ee-harness</title></head><body>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="/data.js"></script>
<script src="/app.js"></script>
</body></html>`;  // no #root → app.js mount throws after globals are defined → inert page

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
async function evalAsync(ws, expr, timeout = 240000) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

let chrome, userDir, failures = 0;
const ok = (l, c, d) => { if (c) console.log(`  ok   ${l}`); else { failures++; console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); } };

try {
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'ee-img-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--remote-debugging-port=9225', `--user-data-dir=${userDir}`, `http://localhost:${PORT}/__harness.html`], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { const list = await (await fetch('http://localhost:9225/json')).json(); target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch {} }
  if (!target) throw new Error('devtools endpoint never came up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Page.enable');

  // Each image gets a fresh page load — recognising several 2622px screenshots
  // through Tesseract twice each would otherwise pile up renderer memory and
  // crash the context. Re-navigation resets it (Tesseract assets stay HTTP-cached).
  async function freshPage() {
    await cdp(ws, 'Page.navigate', { url: `http://localhost:${PORT}/__harness.html` });
    await sleep(400);
    const ready = await evalAsync(ws, `const dl=Date.now()+12000; while(Date.now()<dl && typeof ocrImageFile!=='function'){await new Promise(r=>setTimeout(r,100));} return typeof ocrImageFile==='function' && typeof parseEasyEquitiesScreenshot==='function';`, 20000);
    if (!ready) throw new Error('OCR globals never became available on the inert page');
  }

  console.log('\nSynthetic EE page (purple title bar + body):');
  await freshPage();
  const syn = await evalAsync(ws, `
    const W=1206,H=2622,c=document.createElement('canvas');c.width=W;c.height=H;
    const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,W,H);
    x.fillStyle='#000';x.font='bold 40px Arial';x.fillText('11:13',60,70);
    x.fillStyle='#5B2D8E';x.fillRect(0,150,W,200);
    x.fillStyle='#fff';x.font='bold 44px Arial';x.textBaseline='middle';
    x.fillText('1NVEST MSCI EM Asia Index STANLIB Feeder ETF',90,250);
    x.textBaseline='top';x.fillStyle='#111';x.font='34px Arial';x.fillText('MSCI EM Asia Index Feeder',90,560);
    x.font='bold 52px Arial';x.fillText('ETFEMA',540,470);
    x.font='28px Arial';x.fillStyle='#555';x.fillText('PROFIT/LOSS',540,545);x.fillText('EXCHANGE',880,545);
    x.fillStyle='#159a5a';x.fillText('R1 807.30',540,590);x.fillStyle='#111';x.fillText('JSE',920,590);
    x.fillText('28.72%',540,635);x.fillText('OPEN',900,635);
    x.font='bold 34px Arial';x.fillText('My Holding',90,940);
    const row=(l,v,y)=>{x.font='30px Arial';x.fillStyle='#555';x.fillText(l,110,y);x.fillStyle='#111';x.textAlign='right';x.fillText(v,W-110,y);x.textAlign='left';};
    row('Avg. Purchase Price','R39.93',1200);row('# Shares','157',1320);row('# FSRs','0.6010',1380);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const {text,headerText}=await ocrImageFile(blob);
    const h=parseEasyEquitiesScreenshot(text,'JSE',{headerText})[0]||{};
    return JSON.stringify({headerText:(headerText||'').trim(),name:h.query,ticker:h.tickerHint,shares:h.shares,cost:h.costBasis,market:h.marketHint});
  `);
  const s = JSON.parse(syn);
  console.log('  title-bar OCR :', JSON.stringify(s.headerText));
  console.log('  parsed name   :', JSON.stringify(s.name));
  ok('synthetic: full name (not the short card name)', /MSCI EM Asia Index STANLIB Feeder ETF/i.test(s.name || ''), s.name);
  ok('synthetic: no amount in name', !/[R$£€]\s?\d|\d+\.\d{2}|%/.test(s.name || ''), s.name);
  ok('synthetic: ticker ETFEMA / shares 157.601 / JSE', s.ticker === 'ETFEMA' && Math.abs((s.shares || 0) - 157.601) < 0.01 && s.market === 'JSE', JSON.stringify(s));

  const realFiles = existsSync(SHOTS_DIR) ? readdirSync(SHOTS_DIR).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort() : [];
  console.log(`\nReal screenshots (${realFiles.length}) — exact shipped pipeline:`);
  for (const f of realFiles) {
    let j;
    try {
      await freshPage();
      const r = await evalAsync(ws, `
        const blob = await (await fetch('/test-screenshots/${encodeURIComponent(f)}')).blob();
        const {text,headerText}=await ocrImageFile(blob);
        const h=parseEasyEquitiesScreenshot(text,'JSE',{headerText})[0]||{};
        return JSON.stringify({headerText:(headerText||'').trim(), name:h.query, ticker:h.tickerHint, shares:h.shares, cost:h.costBasis, market:h.marketHint, raw:(text||'').replace(/\\s+/g,' ').slice(0,600)});
      `, 90000);
      j = JSON.parse(r);
    } catch (e) { j = { error: String(e && e.message || e) }; }
    console.log(`\n  ── ${f}`);
    if (j.error) { console.log('     ERROR:', j.error); failures++; continue; }
    console.log(`     title-bar : ${JSON.stringify(j.headerText)}`);
    console.log(`     NAME      : ${JSON.stringify(j.name)}`);
    console.log(`     code      : ${j.ticker}     market: ${j.market}`);
    console.log(`     shares    : ${j.shares}     cost: ${j.cost}`);
    if (/[R$£€]\s?\d|\d+\.\d{2}|%/.test(j.name || '')) { failures++; console.log('     !! amount leaked into name'); }
    console.log(`     full OCR  : ${j.raw}`);
  }

  ws.close();
} catch (e) { failures++; console.error('IMG VERIFY ERROR:', e.message); }
finally { try { chrome?.kill(); } catch {} try { server.close(); } catch {} await sleep(300); try { if (userDir) rmSync(userDir, { recursive: true, force: true }); } catch {} }
console.log(`\n${failures === 0 ? 'IMAGE PIPELINE OK' : failures + ' IMAGE CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
