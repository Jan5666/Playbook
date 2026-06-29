# Refresh Button Peek Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the price-feed status into the header refresh button (status dot at rest) and add an iOS-style press-and-hold "peek" that expands a pill showing the last-updated time.

**Architecture:** A new top-level `RefreshControl` React component replaces both the standalone `.status-chip` and the separate refresh `.icon-btn` in the header. Refresh fires on native `click` (tap + keyboard). Pointer events add a 200 ms hold timer that opens a "peek" overlay pill (width animated to JS-measured text width) and suppresses the trailing click. Status color shows as a small dot badge on the icon, driven by the existing `chipState`.

**Tech Stack:** Vanilla `React.createElement` (no JSX/build) in `app.js`; CSS in `styles.css`; verification via headless-Chrome CDP harnesses in `backend/test/*.mjs` (run with `node`).

## Global Constraints

- No JSX — use `React.createElement` exactly like the surrounding code in `app.js`.
- Do not change feed/polling logic or `refreshChipState` semantics (pb-core.js); only presentation moves.
- iOS easing curve, copied verbatim: `cubic-bezier(0.32, 0.72, 0, 1)`.
- Hold threshold: **200 ms**. Move slop to cancel a pending hold: **10 px** (compared squared, `> 100`).
- Honor `@media (prefers-reduced-motion: reduce)` (disable the expand transition).
- Repo policy: **no unprompted git push**, and commit only on the user's go-ahead. The `Commit` steps below are real but must be confirmed with the user before running (note: current branch is `refactor/phase-3-increment-2-settings-store`; confirm whether to branch first).
- Verification commands run from the repo root on Windows; Chrome path is `C:\Program Files\Google\Chrome\Application\chrome.exe` (already used by sibling harnesses).

---

### Task 1: Failing verification harness for the peek control

**Files:**
- Create: `backend/test/verify-refresh-peek.mjs`

**Interfaces:**
- Consumes: nothing (self-contained harness; serves the real app assets with a mocked network).
- Produces: a `node` test asserting the new DOM contract: `.refresh-ctl`, `.refresh-btn`, `.refresh-peek-text`, `.refresh-dot` (with `chipState.dot` color class), the removal of `.status-chip`, tap-refreshes, and hold-peeks-without-refreshing.

- [ ] **Step 1: Write the failing test harness**

Create `backend/test/verify-refresh-peek.mjs` with this exact content:

```js
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
```

- [ ] **Step 2: Run it to confirm it FAILS**

Run: `node backend/test/verify-refresh-peek.mjs`
Expected: FAIL — `refresh control mounted` is false (no `.refresh-btn` exists yet); the run prints `FAILED` and exits non-zero.

---

### Task 2: `RefreshControl` component + header wiring (makes the harness pass)

**Files:**
- Modify: `app.js` — add the `RefreshControl` component; replace the `.status-chip` + refresh `.icon-btn` in the header with it.

**Interfaces:**
- Consumes: `chipState` (`{ phase, text, dot }` from `refreshChipState`), `loading` (bool), `onChipRefresh` (fn) — all already in `App` scope around app.js:2962–2985.
- Produces: DOM contract `.refresh-ctl` (`+ .peeking` when held), `.refresh-btn`, `.refresh-peek` > `.refresh-peek-text`, `.refresh-dot` (` + chipState.dot` class). Refresh fires via native `click`.

- [ ] **Step 1: Add the `RefreshControl` component**

In `app.js`, locate `function SessionBadge` (around app.js:3590) and insert this complete component immediately **before** it:

```js
// Header refresh control: the price-feed status folded into the refresh button.
// A colored dot shows feed state at rest; a quick tap (native click, also
// keyboard Enter/Space) refreshes; press-and-hold "peeks" a pill that expands
// to the relative-time text and springs closed on release (no refresh). Refresh
// runs on click; pointer events only add the hold→peek and suppress the trailing
// click so a peek-release never refreshes.
function RefreshControl({ chipState, loading, onRefresh }) {
  const [peeking, setPeeking] = useState(false);
  const [peekW, setPeekW] = useState(0);
  const holdRef = useRef(null);
  const startRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);
  const peekingRef = useRef(false);
  const textRef = useRef(null);
  const HOLD_MS = 200, SLOP2 = 100, PAD = 54; // PAD = 14px left + 40px icon clearance

  const clearHold = () => { if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = null; } };
  const open = () => { peekingRef.current = true; suppressClickRef.current = true; setPeeking(true); };
  const close = () => { peekingRef.current = false; setPeeking(false); };

  // Measure the (always-rendered, naturally-sized) text on open and whenever the
  // live label changes while held, so the pill width tracks "Updated 6s ago" etc.
  useEffect(() => {
    if (!peeking) { setPeekW(0); return; }
    const w = textRef.current ? textRef.current.scrollWidth : 0;
    setPeekW(w + PAD);
  }, [peeking, chipState.text]);
  useEffect(() => () => clearHold(), []);

  const onPointerDown = (e) => {
    if (e.button != null && e.button > 0) return;
    suppressClickRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    clearHold();
    holdRef.current = setTimeout(() => { holdRef.current = null; open(); }, HOLD_MS);
  };
  const onPointerMove = (e) => {
    if (!holdRef.current) return;
    const dx = e.clientX - startRef.current.x, dy = e.clientY - startRef.current.y;
    if (dx * dx + dy * dy > SLOP2) clearHold(); // moved → it's a scroll, not a hold
  };
  const endPointer = () => {
    clearHold();
    if (peekingRef.current) { close(); setTimeout(() => { suppressClickRef.current = false; }, 400); }
  };
  const onClick = (e) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; e.preventDefault(); return; }
    onRefresh();
  };

  return React.createElement("div", { className: "refresh-ctl" + (peeking ? " peeking" : "") },
    React.createElement("div", { className: "refresh-peek", "aria-hidden": "true", style: { width: peeking ? peekW + 'px' : undefined } },
      React.createElement("span", { className: "refresh-peek-text", ref: textRef }, chipState.text)),
    React.createElement("button", {
      className: "icon-btn refresh-btn" + (loading ? " spin" : ""),
      onPointerDown, onPointerMove, onPointerUp: endPointer, onPointerCancel: endPointer, onClick,
      onContextMenu: (e) => e.preventDefault(),
      title: chipState.phase === 'error' ? 'Price feed failing — tap to retry' : chipState.text,
      "aria-label": chipState.text + ' — tap to refresh'
    },
      React.createElement(Icon, { name: "refresh" }),
      React.createElement("span", { className: "refresh-dot dot " + chipState.dot })));
}
```

- [ ] **Step 2: Swap the header status-chip + refresh button for `RefreshControl`**

In `app.js` (header JSX, app.js:3332–3350), replace this exact block:

```js
  }, "Playbook")), React.createElement("div", {
    className: "status-chip",
    role: "button",
    tabIndex: 0,
    onClick: onChipRefresh,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChipRefresh(); } },
    title: chipState.phase === 'error'
      ? 'Price feed failing — tap to retry'
      : (lastUpdate ? 'Last refresh ' + lastUpdate.toLocaleTimeString() : 'Loading…'),
    "aria-label": chipState.text
  }, React.createElement("span", {
    className: `dot ${chipState.dot}`
  }), React.createElement("span", null, chipState.text)), React.createElement("button", {
    className: `icon-btn ${loading ? 'spin' : ''}`,
    onClick: onChipRefresh,
    "aria-label": "Refresh"
  }, React.createElement(Icon, {
    name: "refresh"
  })), React.createElement("button", {
```

with:

```js
  }, "Playbook")), React.createElement(RefreshControl, {
    chipState: chipState,
    loading: loading,
    onRefresh: onChipRefresh
  }), React.createElement("button", {
```

(The following `"button"` begins the existing Alerts/bell button — leave it and everything after unchanged.)

- [ ] **Step 3: Run the new harness — it should PASS behaviorally**

Run: `node backend/test/verify-refresh-peek.mjs`
Expected: PASS — `ALL PASSED`. (Visual styling is Task 3; this task proves behavior: dot class, tap-refresh, hold-peek-without-refresh, suppressed click.)

- [ ] **Step 4: Commit** (confirm with the user first — see Global Constraints)

```bash
git add app.js backend/test/verify-refresh-peek.mjs
git commit -m "feat(header): fold feed status into refresh button + hold-to-peek control"
```

---

### Task 3: Premium peek styling + status dot + dead-CSS cleanup

**Files:**
- Modify: `styles.css` — replace the now-dead `.status-chip` rules with the `.refresh-ctl` / `.refresh-peek` / `.refresh-dot` rules (header block, around styles.css:144–151).

**Interfaces:**
- Consumes: the DOM classes produced in Task 2 and the existing `.dot.live/.loading/.stale/.error` color rules (styles.css:152–156, kept).
- Produces: the resting dot badge, the expanding pill animation (iOS easing), continuity (button blends into pill when peeking), and reduced-motion fallback.

- [ ] **Step 1: Replace the `.status-chip` block with the refresh-control styles**

In `styles.css`, replace this exact block (the chip rules from the earlier squeeze fix, around styles.css:144–151):

```css
.status-chip {
  display: flex; align-items: center; gap: 5px;
  padding: 4px 9px; border-radius: 20px;
  background: var(--bg-raised); border: 1px solid var(--border);
  font-size: 10px; color: var(--text-dim); font-family: var(--mono);
  flex-shrink: 1; min-width: 0; overflow: hidden; white-space: nowrap; cursor: pointer;
}
/* The chip — not the brand — absorbs the squeeze: its text ellipsises so a long
   label ("Updated 45s ago", "Couldn't refresh — tap to retry") never pushes
   "Playbook" out. */
.status-chip > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.status-chip:focus-visible { outline: 2px solid var(--emerald); outline-offset: 2px; }
```

with:

```css
/* Refresh control — the price-feed status folded into the refresh button. The
   icon stays a 36px round button; a colored dot shows feed state; press-and-hold
   peeks a pill that expands LEFT out of the button (no reflow of bell/settings). */
.refresh-ctl { position: relative; width: 36px; height: 36px; flex-shrink: 0; z-index: 5; }
.refresh-btn { position: relative; z-index: 2; transition: border-color 0.15s, background 0.18s; }
.refresh-ctl.peeking .refresh-btn { background: transparent; border-color: transparent; }
.refresh-btn:focus-visible { outline: 2px solid var(--emerald); outline-offset: 2px; }
.refresh-dot {
  position: absolute; top: 4px; right: 4px; z-index: 3;
  box-shadow: 0 0 0 1.5px var(--bg-raised); transition: opacity 0.2s;
}
.refresh-ctl.peeking .refresh-dot { opacity: 0; }
/* The peek pill: pinned to the control's right edge, grows leftward via width. */
.refresh-peek {
  position: absolute; top: 0; right: 0; height: 36px; width: 36px;
  box-sizing: border-box; display: flex; align-items: center;
  padding: 0 40px 0 14px; border-radius: 18px;
  background: color-mix(in srgb, var(--bg-raised) 92%, transparent);
  border: 1px solid var(--border);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  overflow: hidden; white-space: nowrap;
  opacity: 0; transform: scale(0.96); transform-origin: right center;
  pointer-events: none; z-index: 1;
  transition: width 280ms cubic-bezier(0.32, 0.72, 0, 1),
              opacity 200ms ease,
              transform 280ms cubic-bezier(0.32, 0.72, 0, 1);
}
.refresh-ctl.peeking .refresh-peek { opacity: 1; transform: scale(1); }
.refresh-peek-text {
  flex: 0 0 auto; font-size: 11px; color: var(--text-dim); font-family: var(--mono);
}
@media (prefers-reduced-motion: reduce) {
  .refresh-peek { transition: opacity 120ms ease; transform: none; }
}
```

- [ ] **Step 2: Re-run the behavioral harness (must still pass)**

Run: `node backend/test/verify-refresh-peek.mjs`
Expected: PASS — `ALL PASSED` (CSS must not regress the DOM contract).

- [ ] **Step 3: Capture a visual sanity screenshot (manual check)**

Run: `node backend/test/verify-extended-hours.mjs`
Expected: PASS, and it writes `test-screenshots/exthours-watchlist.png` / `-detail.png`. Open `exthours-*` and confirm the header shows the round refresh button with a status dot and "Playbook" intact (no leftover chip). (This harness exercises the header on load; it does not script the hold, so it confirms the resting state renders cleanly.)

- [ ] **Step 4: Commit** (confirm with the user first)

```bash
git add styles.css
git commit -m "style(header): premium iOS peek pill + status dot for refresh control"
```

---

### Task 4: Adapt the existing refresh-behavior harness to the new control

**Files:**
- Modify: `backend/test/verify-refresh-behavior.mjs:159–191` — the manual-refresh click selector and the three chip-text assertions.

**Interfaces:**
- Consumes: the new `.refresh-btn` (click to refresh) and `.refresh-peek-text` (always-rendered status text) from Task 2.
- Produces: an updated regression suite that still asserts tap-refresh, cache-bust, and the Updating…→Updated transition under the new control.

- [ ] **Step 1: Update the manual-refresh click selector**

In `backend/test/verify-refresh-behavior.mjs`, replace this line (app.js-side selector `aria-label="Refresh"` no longer exists):

```js
  const clicked = await evals(ws, `const b=document.querySelector('button[aria-label="Refresh"]'); if(!b) return false; b.click(); return true;`);
```

with:

```js
  const clicked = await evals(ws, `const b=document.querySelector('.refresh-btn'); if(!b) return false; b.click(); return true;`);
```

- [ ] **Step 2: Repoint the three status-text assertions at `.refresh-peek-text`**

In the same file, replace this exact block:

```js
  // ---- REFRESH-CONFIDENCE CHIP: live relative time + instant tap ack ----
  const chipText0 = await evals(ws, `return document.querySelector('.status-chip')?.innerText || '';`);
  ok('status chip shows relative/state text (not bare HH:MM)', /ago|just now|Updating|Updated|Loading/i.test(chipText0), JSON.stringify(chipText0));
  await evals(ws, `const c=document.querySelector('.status-chip'); if(c) c.click(); return true;`);
  const chipText1 = await evals(ws, `return document.querySelector('.status-chip')?.innerText || '';`);
  ok('tapping the chip flips to Updating… instantly', /Updating/i.test(chipText1), JSON.stringify(chipText1));
  await sleep(3000);
  const chipText2 = await evals(ws, `return document.querySelector('.status-chip')?.innerText || '';`);
  ok('chip settles to Updated/relative after the sweep', /Updated|ago/i.test(chipText2), JSON.stringify(chipText2));
```

with:

```js
  // ---- REFRESH-CONFIDENCE STATUS (now folded into the refresh button) ----
  const chipText0 = await evals(ws, `return document.querySelector('.refresh-peek-text')?.textContent || '';`);
  ok('refresh control exposes relative/state text (not bare HH:MM)', /ago|just now|Updating|Updated|Loading/i.test(chipText0), JSON.stringify(chipText0));
  await evals(ws, `const c=document.querySelector('.refresh-btn'); if(c) c.click(); return true;`);
  const chipText1 = await evals(ws, `return document.querySelector('.refresh-peek-text')?.textContent || '';`);
  ok('tapping the button flips status to Updating… instantly', /Updating/i.test(chipText1), JSON.stringify(chipText1));
  await sleep(3000);
  const chipText2 = await evals(ws, `return document.querySelector('.refresh-peek-text')?.textContent || '';`);
  ok('status settles to Updated/relative after the sweep', /Updated|ago/i.test(chipText2), JSON.stringify(chipText2));
```

- [ ] **Step 3: Run the updated regression suite**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: PASS — `ALL PASSED` (tap-refresh, cache-bust, and the status transitions all green under the new control).

- [ ] **Step 4: Commit** (confirm with the user first)

```bash
git add backend/test/verify-refresh-behavior.mjs
git commit -m "test: adapt refresh-behavior harness to the new refresh control"
```

---

### Task 5: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run the touched/related harnesses**

Run each and confirm `ALL PASSED`:
- `node backend/test/verify-refresh-peek.mjs`
- `node backend/test/verify-refresh-behavior.mjs`
- `node backend/test/verify-extended-hours.mjs`

Expected: all three print `ALL PASSED` and exit 0.

- [ ] **Step 2: Confirm no stray `.status-chip` references remain**

Run (Grep tool or): search the repo for `status-chip`. Expected matches only in docs/specs/plans, not in `app.js` or `styles.css` or active test harnesses (the refresh-behavior harness was repointed in Task 4).

- [ ] **Step 3: Report results to the user**

Summarize: control behavior verified (tap vs hold), visual states, and the green suites. Await the user's call on committing/branching/pushing per repo policy.
```
