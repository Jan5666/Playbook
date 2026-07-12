# Phase 4 increment 9 — extract `HedgesView` into `pb-views.js` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `HedgesView` verbatim from `app.js` into the existing `pb-views.js` bucket, binding it back via the `window.PBViews` global — proving that a bucket add of an already-bridged shape costs `app.js`-only edits, **zero** new harness/deploy wiring, and **zero** new `PBApp` bridge members.

**Architecture:** One behavior-green extraction task, app green at every step. **Task 1** slices `HedgesView` out of `app.js` into the `pb-views.js` IIFE (injecting two lead reads: `PriceBlock` from the existing bridge, `DATA` from the `window.PB_DATA` global), replaces the `app.js` definition with a `const HedgesView = PBViews.HedgesView` bind, registers it, and bumps the `sw.js` cache — **the `window.PBApp` publish line is untouched** (the payoff: even cheaper than inc 8, which had to grow the bridge). **Task 2** appends the measured read-out to the spec.

**Tech Stack:** Vanilla ES (no build step), React 18 via UMD global, hand-written `React.createElement` (no JSX), `node --check` + existing `node` suites for regression, headless-Chrome `verify-*.mjs` harnesses for mount/render smoke.

## Global Constraints

- **Branch is already created and checked out:** `refactor/phase-4-increment-9-hedges-view`, stacked off the inc-8-complete HEAD `5e0af7b`. The spec (`docs/superpowers/specs/2026-07-12-phase-4-increment-9-hedges-view-design.md`) is already committed on it (`b12a7cd`). If for any reason you are not on this branch, run `git checkout refactor/phase-4-increment-9-hedges-view` (or create it off `5e0af7b`).
- **Byte-verbatim move via Node slice scripts — never the Edit tool, never retype.** `pb-views.js` and `app.js` are both **UTF-8 with a leading BOM (`﻿`) + CRLF (`\r\n`)**. `app.js` authors non-ASCII as `\uXXXX`/`\xXX` ASCII escapes; `HedgesView`'s "Explicitly skipped" list uses `—` (em-dash) escapes, which move byte-for-byte. `pb-views.js` already carries a mix of literal non-ASCII (HotTopicsView box-drawing) and escapes (PicksView's `\xB7`) — the verbatim slice preserves whatever is there. All content surgery uses Node scripts that read as `'utf8'` (keeps the BOM as the first char), `split('\r\n')` / `join('\r\n')`, and write as `'utf8'`. All hand-written code in this plan is pure ASCII.
- **CRLF-safe manual edits:** the `sw.js` cache bump in Task 1 is a **single-line** string replacement (no `\n` inside the matched text), so CRLF vs LF is irrelevant. Everything multi-line goes through a Node script.
- **The bridge does NOT grow.** `window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt };` (7 members) is **unchanged** from inc 8. `HedgesView` consumes only `PriceBlock` from it (already present); it does **not** use `fmt`. The injected lead read is therefore `const { PriceBlock } = window.PBApp;` — `PriceBlock` alone.
- **HedgesView reaches globals directly, app.js-internals via the bridge.** Inside `HedgesView`, `PriceBlock` comes from `window.PBApp`; `DATA` is read as `const DATA = window.PB_DATA;` (the data.js global, mirroring `app.js:11` — **not** routed through `PBApp`); `PBStore.usePricesMap()` stays qualified. `HedgesView` uses **no** React hooks, so no `useEffect`/`useRef` import is needed for it.
- **Load order is unchanged:** `pb-views.js` keeps its slot (after `pb-import.js`, before `data.js` in `index.html`, and before `app.js` everywhere), so `app.js`'s module-scope `const HedgesView = PBViews.HedgesView` bind resolves. Views read `window.PBApp`/`window.PB_DATA` lazily at render, so `app.js`/`data.js` loading later is a non-issue.
- **sw cache bump required, once — re-verify the current version at execution.** At execution: `grep "const CACHE_NAME" sw.js`, then bump by one. The committed value is `playbook-shell-v56`, so this plan bumps to **v57** (bump *that* value by one if the landed value differs).
- **Wiring surface (the payoff — minimal):** `app.js` (remove fn → bind) + `pb-views.js` (splice in + register) + `sw.js` (cache bump only). **Zero** edits to `index.html`, `.github/workflows/static.yml`, the 16 `verify-*.mjs` harnesses, or any `pb-core`/`pb-data`/`pb-store`/`pb-content`/`pb-import`/`data.js`. No worker/wrangler impact.
- **No node unit test is added.** A pure-UI view has no pure surface to node-test; nothing pure moves. Verification is `node --check` + the existing node suite staying green + the browser mount gate + a scratchpad Hedges-tab render check.
- **Commits (subagent-driven run):** the implementer commits its own changes locally on branch `refactor/phase-4-increment-9-hedges-view`. Nothing is pushed. **Jan does the PR/merge; in an inline run, Jan handles commits.** Scratchpad scripts and the render-check harness are throwaway — **not committed** (`scratchpad/` is gitignored as of `5e0af7b`).

**Test runner reference:** no npm script. Run one suite with `node backend/test/<name>.test.mjs`. Whole suite from repo root:
```bash
for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "ok  $f" || echo "FAIL $f"; done
```
The browser mount gate: `node backend/test/verify-refresh-behavior.mjs` (expects a final `ALL PASSED`). Chrome path is hardcoded in the harnesses: `C:\Program Files\Google\Chrome\Application\chrome.exe`.

---

### Task 1: Extract `HedgesView` into `pb-views.js` (bridge unchanged) + bump the sw cache

Move `HedgesView` out of `app.js` into the bucket, switch `app.js` to the global, and bump the service-worker cache. The `window.PBApp` publish is left exactly as inc 8 left it. After this task the Hedges tab renders from `pb-views.js`, and the bucket holds three components.

**Files:**
- Modify: `app.js` (remove `HedgesView` definition → one-line bind + comment), `pb-views.js` (gain `HedgesView` + its registration), `sw.js` (cache bump only)
- Create (throwaway, not committed): `scratchpad/inc9-extract-hedges.mjs`, `scratchpad/inc9-hedges-render.mjs`

**Interfaces:**
- Consumes: the `pb-views.js` global and its `window.PBViews` namespace (from inc 8); the `window.PBApp` bridge with `PriceBlock` already present (from inc 8).
- Produces: `window.PBViews.HedgesView` (a React function component with the `(_ref0)` signature and unchanged `{ onOpenDetail }` prop). `window.PBApp` is **unchanged** at its 7 inc-8 members.

- [ ] **Step 1: Write the extract-and-flip script** `scratchpad/inc9-extract-hedges.mjs`

```js
// scratchpad/inc9-extract-hedges.mjs — run once from repo root; NOT committed.
// Moves HedgesView verbatim app.js -> pb-views.js (injecting PriceBlock bridge read + PB_DATA read),
// replaces the app.js definition with a bind. The PBApp bridge is NOT touched (HedgesView needs only
// PriceBlock, already present). BOM + CRLF + \uXXXX escapes preserved.
import { readFileSync, writeFileSync } from 'node:fs';

// ---- app.js: slice HedgesView out (ASCII markers) ----
const appLines = readFileSync('app.js', 'utf8').split('\r\n');
const pStart = appLines.findIndex(l => l.startsWith('function HedgesView('));
if (pStart < 0) throw new Error('HedgesView start marker not found');
const pEnd = appLines.findIndex((l, i) => i > pStart && l.startsWith('function fmtShares('));
if (pEnd < 0) throw new Error('fmtShares end marker not found');
const moved = appLines.slice(pStart, pEnd); // HedgesView fn, verbatim

// inject the two lead reads immediately after the signature line (PriceBlock only — no fmt)
moved.splice(1, 0,
  '  const { PriceBlock } = window.PBApp;',
  '  const DATA = window.PB_DATA;');

// replace the app.js definition with a one-line bind (+ note)
appLines.splice(pStart, pEnd - pStart,
  '// HedgesView is defined in pb-views.js (Phase 4 inc 9); bind it here.',
  'const HedgesView = PBViews.HedgesView;');

writeFileSync('app.js', appLines.join('\r\n'), 'utf8');

// ---- pb-views.js: insert HedgesView before the registration block, then register it ----
const vLines = readFileSync('pb-views.js', 'utf8').split('\r\n');
const regIdx = vLines.findIndex(l => l.includes('window.PBViews = window.PBViews'));
if (regIdx < 0) throw new Error('PBViews registration marker not found');
vLines.splice(regIdx, 0, '', '// --- Hedges (moved from app.js, Phase 4 inc 9) ---', ...moved);
const picksRegIdx = vLines.findIndex(l => l.includes('window.PBViews.PicksView = PicksView'));
if (picksRegIdx < 0) throw new Error('PicksView registration marker not found');
vLines.splice(picksRegIdx + 1, 0, '  window.PBViews.HedgesView = HedgesView;');
writeFileSync('pb-views.js', vLines.join('\r\n'), 'utf8');

console.log('inc9: moved', moved.length, 'lines (incl. 2 injected); pb-views.js now', vLines.length, 'lines');
```

- [ ] **Step 2: Run the script and syntax-check both files**

Run:
```bash
node scratchpad/inc9-extract-hedges.mjs
node --check app.js
node --check pb-views.js
```
Expected: prints the move confirmation (`moved` ≈ 50 lines); both `node --check` exit 0. If either fails, the markers are wrong — inspect and fix the script, do not hand-edit the files.

- [ ] **Step 3: Verify the source now delegates (anti-drift by grep)**

Run:
```bash
grep -c "const HedgesView = PBViews.HedgesView" app.js          # expect 1
grep -c "^function HedgesView(_ref0)" app.js                    # expect 0 (moved out)
grep -c "window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt }" app.js  # expect 1 (UNCHANGED)
grep -c "^function HedgesView(_ref0)" pb-views.js               # expect 1 (moved in)
grep -c "window.PBViews.HedgesView = HedgesView" pb-views.js    # expect 1
grep -c "const { PriceBlock } = window.PBApp" pb-views.js       # expect 1 (PriceBlock only)
grep -c "const DATA = window.PB_DATA" pb-views.js               # expect 2 (PicksView + HedgesView)
grep -c "window.PBViews\\." pb-views.js                         # expect 3 (Hot + Picks + Hedges registrations)
```
Expected: `1, 0, 1, 1, 1, 1, 2, 3`. Confirms the definition moved, the bind is in place, **the bridge line is unchanged**, the injected `PriceBlock`/`DATA` reads landed exactly once for HedgesView, and the bucket now registers three views. (`PriceBlock`/`fmt` definitions remain in `app.js` — only bridged, not moved.)

- [ ] **Step 4: Bump the sw cache** (single-line edit)

First re-check the current value (`grep "const CACHE_NAME" sw.js`); the committed value is `v56`, so bump to the next version:
- old: `const CACHE_NAME   = 'playbook-shell-v56';`
- new: `const CACHE_NAME   = 'playbook-shell-v57';`

(If the landed value differs from `v56`, bump *that* value by one instead — one increment past whatever is committed.)

- [ ] **Step 5: Run the full node suite — must stay green**

Run:
```bash
for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "ok  $f" || echo "FAIL $f"; done
```
Expected: every line `ok` (money gate included). No money/logic changed by a UI move; suites are unaffected. `deploy-assets.test.mjs` stays `ok` (no deploy-asset set change — the bucket file was already in the allowlist; the cache bump is not asserted by that suite).

- [ ] **Step 6: Run the browser mount gate**

Run:
```bash
node backend/test/verify-refresh-behavior.mjs
```
Expected: final line `ALL PASSED`. App mounts with `app.js` binding `PBViews.HedgesView`; no ReferenceError; holdings-no-badge guard holds. (The Hedges tab is not opened here — the next step covers it.)

- [ ] **Step 7: Write the Hedges-tab render check** `scratchpad/inc9-hedges-render.mjs`

This is the check the mount gate cannot cover: `viewMap` builds `React.createElement(HedgesView, …)` eagerly every render but only *renders* it on the active tab, so a broken bind yields an `undefined` type that only fails when that tab is opened. Adapted from `verify-refresh-behavior.mjs` (same server/Chrome/CDP boilerplate); its script list includes `/pb-views.js`. It also re-checks the Picks tab (inc-8 sibling regression) and asserts `PBApp` did **not** grow.

```js
// scratchpad/inc9-hedges-render.mjs — run once from repo root; NOT committed.
// Opens the Picks tab (sibling regression) and the Hedges tab, asserting each renders from pb-views.js,
// and that the PBApp bridge did NOT grow past its 7 inc-8 members.
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');                       // scratchpad/ is one level under repo root
const PORT = 9933, DBG = 9243;
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
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failures++; };
try {
  await new Promise(r => server.listen(PORT, r));
  userDir = mkdtempSync(join(tmpdir(), 'pb-hedges-'));
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

  // All three views registered; the bridge did NOT grow past 7.
  const registered = await evals(ws, `return typeof window.PBViews?.HotTopicsView === 'function' && typeof window.PBViews?.PicksView === 'function' && typeof window.PBViews?.HedgesView === 'function';`);
  ok('PBViews.{HotTopicsView,PicksView,HedgesView} all registered', registered === true);
  const bridgeSize = await evals(ws, `return Object.keys(window.PBApp || {}).length;`);
  ok('PBApp bridge unchanged at 7 members (no growth)', bridgeSize === 7, 'members=' + bridgeSize);

  // Picks tab still renders (inc-8 sibling regression guard).
  await evals(ws, `document.querySelector('button[data-tab="picks"]')?.click(); return true;`);
  await sleep(900);
  const picksCards = await evals(ws, `return document.querySelectorAll('main .pos-card').length;`);
  ok('Picks tab still renders after bucket add (.pos-card)', picksCards >= 1, 'cards=' + picksCards);

  // Hedges tab renders (the new extraction). The nav renders every tab button in the DOM.
  const opened = await evals(ws, `const b=document.querySelector('button[data-tab="hedges"]'); if(!b) return false; b.click(); return true;`);
  ok('hedges tab nav button exists & clickable', opened === true);
  await sleep(1000);
  const cards = await evals(ws, `return document.querySelectorAll('main .pos-card').length;`);
  ok('Hedges tab renders the .pos-card grid (extracted HedgesView mounted)', cards >= 1, 'cards=' + cards);
  // Encoding sanity: the moved em-dash in the "Explicitly skipped" list renders without mojibake.
  const skipped = await evals(ws, `return document.querySelector('main .bullet-list')?.textContent || '';`);
  ok('moved em-dash copy renders intact (U+2014 present, no U+FFFD)',
     skipped.indexOf(String.fromCharCode(0x2014)) !== -1 && skipped.indexOf(String.fromCharCode(0xFFFD)) === -1,
     JSON.stringify(skipped.slice(0, 40)));

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) { console.error('ERROR', e); failures++; }
finally { try { chrome && chrome.kill(); } catch {} try { server.close(); } catch {} process.exit(failures === 0 ? 0 : 1); }
```

- [ ] **Step 8: Run the Hedges-tab render check**

Run:
```bash
node scratchpad/inc9-hedges-render.mjs
```
Expected: final line `ALL PASSED` — app mounts, all three views registered, `PBApp` still at 7 members, the Picks tab still renders (sibling regression clear), the Hedges tab renders ≥1 `.pos-card`, and the moved em-dash copy renders without mojibake. If `.pos-card` count is 0 on the hedges tab, the bind is broken — re-check Step 3 and that `pb-views.js` is in the harness script list above.

- [ ] **Step 9: Commit** (SDD run; in an inline run Jan commits)

```bash
git add app.js pb-views.js sw.js
git commit -m "refactor(view): extract HedgesView into pb-views.js bucket (bridge unchanged); sw v56->v57"
```

---

### Task 2: Append the measured read-out to the spec

Record the sharpened bucketing economics this increment set out to demonstrate, beside the design.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-12-phase-4-increment-9-hedges-view-design.md` (append a "Measured read-out" section)

**Interfaces:** none (documentation).

- [ ] **Step 1: Measure the actual deltas**

Run:
```bash
echo "app.js delta vs branch point:"; git diff --stat 5e0af7b -- app.js
echo "pb-views.js size:"; wc -l pb-views.js
echo "bridge members (expect the 7-member line, unchanged):"; grep -o "window.PBApp = {[^}]*}" app.js
echo "views in bucket (expect 3):"; grep -c "window.PBViews\\." pb-views.js
echo "sw cache:"; grep "const CACHE_NAME" sw.js
```
Record: the `app.js` line delta (≈ −46), `pb-views.js` size (≈ 278), the bridge member count (still 7), the bucket now holding 3 views, and the sw cache version.

- [ ] **Step 2: Append the read-out to the spec**

Append this section (fill the bracketed numbers from Step 1) to `docs/superpowers/specs/2026-07-12-phase-4-increment-9-hedges-view-design.md`:

```markdown
## Measured read-out (filled after execution)

**Sharpened bucketing economics, measured:**
- **Wiring cost (the payoff):** `app.js` (remove fn → bind) + `pb-views.js` (splice + register) +
  **one** `sw.js` cache bump (v[NN]→v[NN]). **Zero** new harness / static.yml / index.html edits and
  **zero** new `PBApp` members — even cheaper than inc 8, which had to grow the bridge by 2. `app.js`
  [−N] lines; `pb-views.js` grew to [N] lines; bucket now holds **3** components
  (HotTopicsView + PicksView + HedgesView).
- **Bridge:** `window.PBApp` stayed at **7** members (verified: the publish line is byte-unchanged and
  the render check asserted `Object.keys(window.PBApp).length === 7`). `HedgesView` consumed only
  `PriceBlock` (a subset of inc 8's additions) and reached `DATA` via `window.PB_DATA` directly — so a
  same-shape view added **nothing** to the grab-bag. This is the cleanest demonstration of the thesis:
  once a shape's app.js-internals are bridged, each further view of that shape is a pure app.js↔bucket move.
- **Verification friction:** unchanged from inc 7/8 — no node test possible for a pure-UI view;
  correctness rode entirely on the browser render check. The eager `viewMap`
  `createElement(HedgesView,...)` only renders on the active tab, so a broken bind would have been
  invisible to the mount gate. The Hedges-tab render check ([N] `.pos-card` cards, em-dash in the
  "Explicitly skipped" list intact — U+2014 present, no U+FFFD, Picks sibling still rendering) is the
  check that actually proved it, and caught [nothing / any issue found].

**Conclusion:** the read-out's thesis holds at its strongest — for a view whose shape is already
bridged, the per-component cost is `app.js` + bucket splice + a one-line sw bump, with **zero** bridge
growth. The remaining ~17 components amortize against the already-paid bucket wiring; simple same-shape
views (further `PriceBlock`/`DATA` tabs) are the cheapest, modals (money/alert + portal shape) the next
real cost step.
```

- [ ] **Step 3: Commit** (SDD run; in an inline run Jan commits)

```bash
git add docs/superpowers/specs/2026-07-12-phase-4-increment-9-hedges-view-design.md
git commit -m "docs(inc9): measured read-out — zero-bridge-growth bucket add"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- Goal / scope (extract HedgesView into pb-views.js, bridge unchanged) → Task 1.
- Dependency inventory (bridge `PriceBlock` only; read `window.PB_DATA` directly; no hooks; no `fmt`) → Task 1 Step 1 (injected lead reads), verified Task 1 Step 3.
- Bridge does not grow → Global Constraints + Task 1 Step 1 (publish line untouched) + Step 3 grep (bridge line unchanged) + render check Step 7 (`Object.keys(window.PBApp).length === 7`).
- Mechanism (`pb-views.js` IIFE with three views; `app.js` bind; TDZ-safe const bind) → Task 1 Steps 1–3.
- Extraction discipline (verbatim slice, BOM/CRLF, `—` escapes, only-edited-lines are the two injected reads) → Global Constraints + Task 1 Step 1 script.
- Wiring — minimal (app.js + pb-views.js + sw cache bump only; zero harness/index/static) → Task 1 Steps 1–4; verified by the unchanged grep counts + green deploy-assets suite (Step 5).
- Verification gate (node --check both, node suite incl. deploy-assets + money gate, mount gate, **Hedges-tab render check** + Picks regression + encoding sanity + bridge-size assert) → Task 1 Steps 2, 5, 6, 8.
- Deliverable (measured read-out) → Task 2.
- Out-of-scope (no PBContent prose extraction, no RulesView, no modal, no pb-core push, no Context, no Vite) → honored; none implemented.

**Placeholder scan:** No "TBD"/"handle errors"/"similar to Task N". The read-out template in Task 2 Step 2 has bracketed numbers **by design** — filled from the explicit Task 2 Step 1 measurement. All code steps show complete code.

**Type/name consistency:** `window.PBViews.HedgesView`, `const HedgesView = PBViews.HedgesView`, the injected `const { PriceBlock } = window.PBApp;` (PriceBlock only, matching the unchanged 7-member publish) and `const DATA = window.PB_DATA;` are spelled identically in the extract script (Task 1 Step 1), the anti-drift greps (Task 1 Step 3), and the render check (Task 1 Step 7). Markers `function HedgesView(` / `function fmtShares(` / `window.PBViews = window.PBViews` / `window.PBViews.PicksView = PicksView` are used identically in the extract script and verified by the greps. Cache `v56`→`v57` and the branch-point SHA `5e0af7b` are consistent throughout.
