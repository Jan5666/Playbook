# Phase 4 increment 7 — HotTopicsView → pb-view-hot.js (no-build spike) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the single React component `HotTopicsView` out of `app.js` into a new browser-only global script `pb-view-hot.js`, establishing the reusable `window.PBApp` app-runtime bridge by which an extracted global-script component reaches shared `app.js` internals it cannot `import`.

**Architecture:** Duplicate-then-remove, in two code tasks so the app stays green at every step. Task 1 creates `pb-view-hot.js` (view + its two view-local consts, verbatim) and wires it into every load path (index.html, sw precache, deploy allowlist, all 16 verify harnesses) **while `app.js` still owns the inline copy** — the new global is present but unused. Task 2 flips `app.js`: publishes `window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName }` before render, deletes the inline view/consts, and binds `const HotTopicsView = PBViews.HotTopicsView`. Task 3 writes the spike read-out (the increment's actual purpose: cost data for the deferred Vite decision).

**Tech Stack:** Vanilla ES (no build step), React 18 via UMD global, hand-written `React.createElement` (no JSX), `node --check` + existing `node` suites for regression, headless-Chrome `verify-*.mjs` harnesses for mount/render smoke.

## Global Constraints

- **Byte-verbatim move via Node slice scripts — never the Edit tool, never retype.** The moved span (`app.js` `8473`–`8622` on `f2028f1`) contains **literal** non-ASCII: box-drawing `─` in comments (`// ─── Hot Topics ───`, `// ── header ──`), ellipsis `…` (`'Loading…'`, `'Refreshing Hot Topics…'`), middot `·` (`'Live · AI …'`). The Edit tool cannot round-trip these. All moves use Node scripts that read `app.js` as UTF-8 and splice by **ASCII markers**, preserving bytes. All hand-written code in this plan is pure ASCII.
- **`app.js` is UTF-8 with a leading BOM + CRLF (`\r\n`) line endings.** Slice scripts must `split('\r\n')` / `join('\r\n')` and must not strip the BOM (reading with `'utf8'` keeps it as the first character; writing with `'utf8'` restores the BOM bytes — round-trip preserves it). `pb-view-hot.js` is written UTF-8 **with** a leading BOM (`﻿`) and CRLF to match `app.js`, since it too carries literal glyphs.
- **The bridge is exactly 5 members:** `window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName };`. This is the complete external set the view needs (verified by exhaustive body scan). `Icon` (app.js:1321) is a React component; `timeAgo` (1237), `hotToDate` (965), `hotDayDiff` (973), `prettyName` (6075) are shared pure helpers used elsewhere in `app.js` — all **stay** in `app.js` and are reached through the bridge. Do **not** move them.
- **Move with the view (view-local, unused elsewhere):** `HOT_TAG_LABEL` (app.js:8477) and `hotCountdown` (8481). The view uses `useEffect`/`useRef` **unqualified**, so the new file's IIFE must open with `const { useEffect, useRef } = React;`. `React.createElement`/`React.Fragment` stay qualified; `PBStore.usePricesMap()` stays qualified (PBStore is a global).
- **Load order is fixed:** `pb-view-hot.js` loads **after `pb-import.js`, before `data.js`** in `index.html`, and **before `app.js`** everywhere (so `app.js`'s module-scope `const HotTopicsView = PBViews.HotTopicsView` bind resolves). The view reads `window.PBApp` lazily at render time, so it does not matter that `app.js` (which publishes `PBApp`) loads later.
- **sw cache bump required:** `CACHE_NAME` `playbook-shell-v51` → `playbook-shell-v52` in `sw.js`.
- **Wiring surface (the tax being measured):** `index.html` (1 line) + `sw.js` SHELL_ASSETS (1 line) + `sw.js` cache bump (1) + `.github/workflows/static.yml` (cp list + Guard-1 loop, 2 lines) + all **16** app-mounting `backend/test/verify-*.mjs` harness shells (1 `<script>` each). No worker/wrangler impact (the worker bundles `pb-core`, never view code). `pb-core`/`pb-data`/`pb-store`/`pb-content`/`pb-import`/`data.js` untouched.
- **No node unit test is added.** A pure-UI view has no pure surface to node-test; nothing pure moves. Verification is `node --check` + the existing node suite staying green + the browser mount gate + a scratchpad Hot-tab render check. (Confirmed lesson: node suites never load `app.js` in a browser — extraction bugs only surface in a browser smoke.)
- **Commits (subagent-driven run):** each task's implementer commits its own changes locally on branch `refactor/phase-4-increment-7-hottopics-view` — standard SDD per-task commits, as in inc-4/inc-5. Nothing is pushed. **Jan does the final PR/merge to main; in an inline run, Jan handles commits.** Scratchpad scripts and the render-check harness are throwaway — **not committed**.

**Test runner reference:** no npm script. Run one suite with `node backend/test/<name>.test.mjs`. Whole suite from repo root:
```bash
for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "ok  $f" || echo "FAIL $f"; done
```
The browser mount gate: `node backend/test/verify-refresh-behavior.mjs` (expects a final `ALL PASSED`). Chrome path is hardcoded in the harness: `C:\Program Files\Google\Chrome\Application\chrome.exe`.

---

### Task 1: Create `pb-view-hot.js` (duplicate phase) and wire it into every load path

`app.js` is **not modified** in this task. The new global is loaded everywhere but unused (app.js still renders its own inline `HotTopicsView`), so the app must still mount identically. This isolates the wiring tax and proves the new script loads harmlessly before any behavior flips.

**Files:**
- Create: `pb-view-hot.js` (repo root)
- Create (throwaway, not committed): `scratchpad/inc7-extract.mjs`, `scratchpad/inc7-wire-harnesses.mjs`
- Modify: `index.html` (1 line), `sw.js` (SHELL_ASSETS + CACHE_NAME), `.github/workflows/static.yml` (2 lines), all 16 `backend/test/verify-*.mjs` app-mounting shells

**Interfaces:**
- Produces: global `window.PBViews.HotTopicsView` (a React function component with the same `(_refHT)` signature as the current `app.js` `HotTopicsView`). Consumes at render time: `window.PBApp.{Icon,timeAgo,hotToDate,hotDayDiff,prettyName}` (published by app.js in Task 2), `PBStore.usePricesMap`, `React`.
- Consumes: nothing from earlier tasks (first task).

- [ ] **Step 1: Write the extract script** `scratchpad/inc7-extract.mjs`

```js
// scratchpad/inc7-extract.mjs — run once from repo root; NOT committed.
// Slices HotTopicsView (+ its view-local consts + banner comment) verbatim out of
// app.js into pb-view-hot.js, injecting the PBApp bridge-read into the fn body.
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('app.js', 'utf8');   // keeps BOM + CRLF + literal glyphs
const lines = src.split('\r\n');

const tag = lines.findIndex(l => l.includes('const HOT_TAG_LABEL = {'));
if (tag < 0) throw new Error('HOT_TAG_LABEL marker not found');
// extend upward over the immediately-preceding // comment banner ("Hot Topics …")
let start = tag;
while (start > 0 && lines[start - 1].trimStart().startsWith('//')) start--;
const end = lines.findIndex((l, i) => i > tag && l.startsWith('function ruleSection('));
if (end < 0) throw new Error('ruleSection end marker not found');

const moved = lines.slice(start, end);        // banner + HOT_TAG_LABEL + hotCountdown + HotTopicsView
const fnIdx = moved.findIndex(l => l.startsWith('function HotTopicsView('));
if (fnIdx < 0) throw new Error('HotTopicsView fn not found in slice');
// inject the bridge-read as the first statement of the fn body
moved.splice(fnIdx + 1, 0,
  '  const { Icon, timeAgo, hotToDate, hotDayDiff, prettyName } = window.PBApp;');

const header = [
  '// pb-view-hot.js - HotTopicsView, extracted from app.js (Phase 4 inc 7 spike).',
  '// Browser-only classic script. Registers window.PBViews.HotTopicsView and reads shared',
  '// app.js primitives (Icon + helpers) from window.PBApp at render time.',
  '(function () {',
  '  const { useEffect, useRef } = React; // UMD global; view uses these hooks unqualified',
];
const footer = [
  '  window.PBViews = window.PBViews || {};',
  '  window.PBViews.HotTopicsView = HotTopicsView;',
  '})();',
  '',
];
// Prepend a UTF-8 BOM (U+FEFF) to match app.js and guarantee UTF-8 decoding of the
// literal glyphs the moved span carries. Built via fromCharCode so this stays pure ASCII.
const out = String.fromCharCode(0xFEFF) + header.concat(moved, footer).join('\r\n');
writeFileSync('pb-view-hot.js', out, 'utf8');
console.log('wrote pb-view-hot.js -', out.split('\r\n').length, 'lines; moved', moved.length, 'source lines');
```

- [ ] **Step 2: Run the extract script and syntax-check the new file**

Run:
```bash
mkdir -p scratchpad
node scratchpad/inc7-extract.mjs
node --check pb-view-hot.js
```
Expected: prints `wrote pb-view-hot.js — ~150 lines; moved ~150 source lines`; `node --check` exits 0 (no output). If `node --check` fails, the slice boundaries are wrong — inspect and fix the markers, do not hand-edit `pb-view-hot.js`.

- [ ] **Step 3: Sanity-check the extracted file's shape**

Run:
```bash
grep -c "window.PBViews.HotTopicsView = HotTopicsView" pb-view-hot.js   # expect 1
grep -c "const { Icon, timeAgo, hotToDate, hotDayDiff, prettyName } = window.PBApp" pb-view-hot.js  # expect 1
grep -c "const { useEffect, useRef } = React" pb-view-hot.js            # expect 1
grep -c "function HotTopicsView(_refHT)" pb-view-hot.js                 # expect 1
```
Expected: each prints `1`. Confirms the wrapper, bridge-read, hooks destructure, and the moved fn are all present exactly once.

- [ ] **Step 4: Add the `<script>` tag to `index.html`**

Edit `index.html` — insert `pb-view-hot.js` after `pb-import.js`, before `data.js`:
- old:
```html
<script src="./pb-import.js"></script>
<script src="./data.js"></script>
```
- new:
```html
<script src="./pb-import.js"></script>
<script src="./pb-view-hot.js"></script>
<script src="./data.js"></script>
```

- [ ] **Step 5: Add `pb-view-hot.js` to `sw.js` SHELL_ASSETS and bump the cache**

Edit `sw.js` — SHELL_ASSETS entry (after `'./pb-import.js',`, before `'./app.js',`):
- old:
```js
  './pb-import.js',
  './app.js',
```
- new:
```js
  './pb-import.js',
  './pb-view-hot.js',
  './app.js',
```

Edit `sw.js` — cache bump:
- old: `const CACHE_NAME   = 'playbook-shell-v51';`
- new: `const CACHE_NAME   = 'playbook-shell-v52';`

- [ ] **Step 6: Add `pb-view-hot.js` to the deploy allowlist (`static.yml`)**

Edit `.github/workflows/static.yml` with **replace-all** on the shared substring (it occurs in both the `cp` list at line 44 and the Guard-1 loop at line 50):
- old (replace all): `pb-import.js styles.css \`
- new (replace all): `pb-import.js pb-view-hot.js styles.css \`

Verify both lines updated:
```bash
grep -c "pb-view-hot.js" .github/workflows/static.yml   # expect 2
```
Expected: `2`.

- [ ] **Step 7: Write the harness-wiring script** `scratchpad/inc7-wire-harnesses.mjs`

```js
// scratchpad/inc7-wire-harnesses.mjs — run once from repo root; NOT committed.
// Adds <script src="/pb-view-hot.js"> after /pb-import.js in every app-mounting harness.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'backend/test';
let n = 0;
for (const f of readdirSync(dir).filter(f => /^verify-.*\.mjs$/.test(f))) {
  const p = join(dir, f);
  let s = readFileSync(p, 'utf8');
  if (!s.includes('/pb-import.js')) continue;   // skip non-app-mounting harnesses
  if (s.includes('/pb-view-hot.js')) continue;  // idempotent
  s = s.replace('<script src="/pb-import.js"></script>',
                '<script src="/pb-import.js"></script>\n<script src="/pb-view-hot.js"></script>');
  writeFileSync(p, s, 'utf8');
  n++; console.log('wired', f);
}
console.log('wired', n, 'harnesses');
```

- [ ] **Step 8: Run the harness-wiring script**

Run:
```bash
node scratchpad/inc7-wire-harnesses.mjs
grep -l "/pb-view-hot.js" backend/test/verify-*.mjs | wc -l   # expect 16
```
Expected: prints `wired 16 harnesses`; the grep count is `16`.

- [ ] **Step 9: Confirm `app.js` is unchanged and still parses**

Run:
```bash
git diff --name-only app.js    # expect NO output (app.js untouched this task)
node --check app.js            # exits 0
```
Expected: `app.js` is not in the diff; `node --check` clean. (The inline `HotTopicsView` still lives in `app.js`; the new global is loaded but unused.)

- [ ] **Step 10: Run the full node suite — must stay green**

Run:
```bash
for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "ok  $f" || echo "FAIL $f"; done
```
Expected: every line `ok` (money gate included). Nothing pure changed, so no suite should regress.

- [ ] **Step 11: Run the browser mount gate**

Run:
```bash
node backend/test/verify-refresh-behavior.mjs
```
Expected: final line `ALL PASSED`. Its shell now loads `pb-view-hot.js`; the app must mount with no `PBViews`/`PBApp` ReferenceError, and the standing `holdings rows deliberately have NO session badge` guard must still hold. (The Hot tab is not opened here; app.js's inline view still serves it.)

- [ ] **Step 12: Commit** (SDD run; in an inline run Jan commits)

```bash
git add pb-view-hot.js index.html sw.js .github/workflows/static.yml backend/test/verify-*.mjs
git commit -m "refactor(view): add pb-view-hot.js + wiring (duplicate phase, app.js unchanged)"
```

---

### Task 2: Flip `app.js` to the extracted view and publish the `PBApp` bridge

Now remove the inline copy and switch `app.js` to the global. After this task the Hot tab renders from `pb-view-hot.js`.

**Files:**
- Modify: `app.js` (remove the `8473`–`8622` block → one-line bind; add the `window.PBApp` publish before `createRoot`)
- Create (throwaway, not committed): `scratchpad/inc7-flip.mjs`, `scratchpad/inc7-hot-render.mjs`

**Interfaces:**
- Consumes: `window.PBViews.HotTopicsView` (from Task 1).
- Produces: `window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName }` at module scope, before render — the reusable bridge future component splits extend.

- [ ] **Step 1: Write the flip script** `scratchpad/inc7-flip.mjs`

```js
// scratchpad/inc7-flip.mjs — run once from repo root; NOT committed.
// Removes the inline HotTopicsView block from app.js (verbatim, by ASCII markers) and
// replaces it with a bind; publishes the PBApp bridge just before ReactDOM.createRoot.
import { readFileSync, writeFileSync } from 'node:fs';

const lines = readFileSync('app.js', 'utf8').split('\r\n');   // preserves BOM + CRLF

const tag = lines.findIndex(l => l.includes('const HOT_TAG_LABEL = {'));
if (tag < 0) throw new Error('HOT_TAG_LABEL marker not found');
let start = tag;
while (start > 0 && lines[start - 1].trimStart().startsWith('//')) start--;
const end = lines.findIndex((l, i) => i > tag && l.startsWith('function ruleSection('));
if (end < 0) throw new Error('ruleSection end marker not found');

// 1) replace the whole inline block with a one-line bind (+ note)
lines.splice(start, end - start,
  '// HotTopicsView is defined in pb-view-hot.js (Phase 4 inc 7 spike); bind it here.',
  'const HotTopicsView = PBViews.HotTopicsView;');

// 2) publish the app-runtime bridge immediately before createRoot (all 5 members defined by now)
const rootIdx = lines.findIndex(l => l.includes('const root = ReactDOM.createRoot('));
if (rootIdx < 0) throw new Error('createRoot line not found');
lines.splice(rootIdx, 0,
  '// App-runtime bridge: shared primitives that extracted view/modal scripts read at render.',
  'window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName };');

writeFileSync('app.js', lines.join('\r\n'), 'utf8');
console.log('app.js flipped: inline HotTopicsView block removed, bind + PBApp publish added');
```

- [ ] **Step 2: Run the flip script and syntax-check**

Run:
```bash
node scratchpad/inc7-flip.mjs
node --check app.js
```
Expected: prints the flip confirmation; `node --check` exits 0.

- [ ] **Step 3: Verify the source now delegates (anti-drift by grep)**

Run:
```bash
grep -c "const HotTopicsView = PBViews.HotTopicsView" app.js        # expect 1
grep -c "window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName }" app.js   # expect 1
grep -c "^function HotTopicsView(_refHT)" app.js                    # expect 0 (inline copy gone)
grep -c "const HOT_TAG_LABEL = {" app.js                            # expect 0 (moved out)
grep -c "^function hotCountdown(" app.js                            # expect 0 (moved out)
```
Expected: `1`, `1`, `0`, `0`, `0`. Confirms the inline view + its two view-local consts are gone and the bind + bridge are in place. (`hotToDate`/`hotDayDiff`/`timeAgo`/`prettyName`/`Icon` definitions remain in `app.js` — they were only bridged, not moved.)

- [ ] **Step 4: Run the full node suite — must stay green**

Run:
```bash
for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "ok  $f" || echo "FAIL $f"; done
```
Expected: every line `ok`. (No money/logic changed; suites are unaffected by a UI move.)

- [ ] **Step 5: Run the browser mount gate**

Run:
```bash
node backend/test/verify-refresh-behavior.mjs
```
Expected: final line `ALL PASSED`. App mounts with `app.js` now binding `PBViews.HotTopicsView` and publishing `PBApp`; no ReferenceError; holdings-no-badge guard holds.

- [ ] **Step 6: Write the Hot-tab render check** `scratchpad/inc7-hot-render.mjs`

This is the critical check the mount gate cannot cover: `viewMap` builds `React.createElement(HotTopicsView, …)` eagerly but only *renders* it on the Hot tab, so a broken bind yields an `undefined` type that only fails when that tab is opened. Adapted from `verify-refresh-behavior.mjs` (same server/Chrome/CDP boilerplate); its script list includes `/pb-view-hot.js`.

```js
// scratchpad/inc7-hot-render.mjs — run once from repo root; NOT committed.
// Opens the Hot tab and asserts HotTopicsView (from pb-view-hot.js) renders.
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');                       // scratchpad/ is one level under repo root
const PORT = 9931, DBG = 9241;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const VERIFY_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css"></head><body>
<div id="root"></div>
<script>
  // Mock every network call with a benign empty JSON payload (no AI key ⇒ scheduled
  // calendar path; sections still render with their empty/most-scheduled states).
  window.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
</script>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="/pb-core.js"></script>
<script src="/pb-data.js"></script>
<script src="/pb-store.js"></script>
<script src="/pb-content.js"></script>
<script src="/pb-import.js"></script>
<script src="/pb-view-hot.js"></script>
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
  userDir = mkdtempSync(join(tmpdir(), 'pb-hot-'));
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

  // The extracted component is registered as a global.
  const registered = await evals(ws, `return typeof window.PBViews?.HotTopicsView === 'function' && typeof window.PBApp?.Icon !== 'undefined';`);
  ok('PBViews.HotTopicsView registered & PBApp bridge published', registered === true);

  // Open the Hot tab and assert the extracted view renders.
  const opened = await evals(ws, `const b=document.querySelector('button[data-tab="hot"]'); if(!b) return false; b.click(); return true;`);
  ok('hot tab nav button exists & clickable', opened === true);
  await sleep(1200);

  const hasView = await evals(ws, `return !!document.querySelector('.hot-view');`);
  ok('.hot-view renders (extracted HotTopicsView mounted)', hasView === true);
  const title = await evals(ws, `return document.querySelector('.hot-title')?.textContent || '';`);
  ok('renders the "Hot Topics" header', /Hot Topics/.test(title), JSON.stringify(title));
  const sections = await evals(ws, `return document.querySelectorAll('.hot-view .hot-section').length;`);
  ok('renders the hot sections (earnings/macro/news)', sections >= 2, 'sections=' + sections);
  // Encoding sanity: the moved literal-glyph subtitle renders without mojibake — i.e.
  // no U+FFFD replacement char (what a corrupted middot/ellipsis would decode to).
  const sub = await evals(ws, `return document.querySelector('.hot-sub')?.textContent || '';`);
  ok('moved literal-glyph copy renders intact (no U+FFFD replacement char)', sub.length > 0 && sub.indexOf(String.fromCharCode(0xFFFD)) === -1, JSON.stringify(sub));

  ws.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
} catch (e) { console.error('ERROR', e); failures++; }
finally { try { chrome && chrome.kill(); } catch {} try { server.close(); } catch {} process.exit(failures === 0 ? 0 : 1); }
```

- [ ] **Step 7: Run the Hot-tab render check**

Run:
```bash
node scratchpad/inc7-hot-render.mjs
```
Expected: final line `ALL PASSED` — `.hot-view` renders, "Hot Topics" header present, ≥2 hot sections, `PBViews.HotTopicsView`/`PBApp` live, and the moved `·` subtitle renders without mojibake. If `.hot-view` is absent, the bind or bridge is broken — re-check Task 2 Step 3 and that `pb-view-hot.js` is in the harness script list above.

- [ ] **Step 8: Commit** (SDD run; in an inline run Jan commits)

```bash
git add app.js
git commit -m "refactor(view): extract HotTopicsView to pb-view-hot.js via PBApp bridge"
```

---

### Task 3: Write the spike read-out

The spike's actual product: a short, concrete read-out that gives Jan the cost data to make the deferred Vite-vs-no-build call. Append it to the spec so it lives beside the design.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-11-phase-4-increment-7-hottopics-view-design.md` (append a "Spike read-out" section)

**Interfaces:** none (documentation).

- [ ] **Step 1: Measure the actual wiring tax**

Run:
```bash
echo "app.js delta:"; git diff --stat main -- app.js 2>/dev/null || git diff --stat HEAD~2 -- app.js
echo "new file lines:"; wc -l pb-view-hot.js
echo "registration touchpoints: 1 index.html + 1 sw SHELL_ASSETS + 1 sw cache + 2 static.yml + 16 harnesses = 21 edits across 19 files"
echo "bridge members:"; grep -o "window.PBApp = {[^}]*}" app.js
```
Record: `app.js` line delta (≈ −143), `pb-view-hot.js` size (≈ 150), the touchpoint count, and the bridge member count (5).

- [ ] **Step 2: Append the read-out to the spec**

Append this section (fill the bracketed numbers with the Step 1 measurements) to `docs/superpowers/specs/2026-07-11-phase-4-increment-7-hottopics-view-design.md`:

```markdown
## Spike read-out (filled after execution)

**One-component cost, measured:**
- **New file:** `pb-view-hot.js` (~[N] lines). **`app.js`:** [−N] lines.
- **Wiring tax:** [N] registration edits across [N] files to load one component —
  index.html (1) + sw SHELL_ASSETS (1) + sw cache bump (1) + static.yml (2) + 16 harness
  shells (16). This scales **linearly per new component file**.
- **Bridge:** `window.PBApp` exports [N] members. HotTopicsView needed 5
  (`Icon`, `timeAgo`, `hotToDate`, `hotDayDiff`, `prettyName`). The reverse-global read
  (`const {…} = window.PBApp`) is ergonomic and one line; the risk is `PBApp` growing into a
  large grab-bag as more components are split (each adds the union of its shared helpers).
- **Verification friction:** no node test possible; correctness rides entirely on the browser
  render check, and a broken bind is invisible to the mount gate (only the active tab renders).

**Recommendation for the Vite decision:** [one paragraph — e.g., no-build is tolerable for a
handful more splits if view files are bucketed to amortize the 16-harness tax, OR the per-file
tax + no-JSX + growing PBApp argues for Vite before splitting the ~20 remaining components.
State the call and hand it to Jan.]
```

- [ ] **Step 3: Commit** (SDD run; in an inline run Jan commits)

```bash
git add docs/superpowers/specs/2026-07-11-phase-4-increment-7-hottopics-view-design.md
git commit -m "docs(inc7): spike read-out — one-component split cost + Vite recommendation"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- Goal / scope (extract HotTopicsView, no-build, Approach A bridge) → Tasks 1–2.
- Dependency inventory (move `HOT_TAG_LABEL`/`hotCountdown`; bridge `Icon`/`timeAgo`/`hotToDate`/`hotDayDiff`/`prettyName`) → Task 1 Step 1 (extract), Task 2 Step 1 (bridge publish), verified Task 2 Step 3.
- Mechanism (PBViews registration + PBApp reverse bridge, lazy call-time read, `const HotTopicsView = PBViews.HotTopicsView`) → Task 1 Step 1 + Task 2 Step 1.
- Extraction discipline (verbatim slice, UTF-8/BOM/CRLF, literal glyphs, only-edited-line is the bridge-read) → Global Constraints + both slice scripts.
- Wiring (index.html, sw SHELL_ASSETS + v51→v52, static.yml ×2, 16 harnesses) → Task 1 Steps 4–8.
- Verification gate (node --check, node suite, mount gate, **Hot-tab render check**, encoding sanity) → Task 1 Steps 9–11, Task 2 Steps 2–7.
- Spike deliverable (read-out feeding the Vite decision) → Task 3.
- Out-of-scope items (no 2nd component, no helper→pb-core, no Context, no Icon relocation, naming deferred) → honored; none implemented.

**Placeholder scan:** No "TBD"/"handle errors"/"similar to". The read-out template in Task 3 Step 2 has bracketed numbers **by design** — they are filled from the Task 3 Step 1 measurement, and that step is explicit. All code steps show complete code.

**Type/name consistency:** `window.PBViews.HotTopicsView` and `window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName }` are spelled identically in the extract script (Task 1), the flip script (Task 2), the anti-drift grep (Task 2 Step 3), and the render check (Task 2 Step 6). The bridge-read destructure in `pb-view-hot.js` matches the `PBApp` publish member-for-member. Cache version `v51`→`v52` consistent. Harness count `16` consistent throughout.
