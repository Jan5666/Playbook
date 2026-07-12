# Phase 4 increment 8 — bucketing: `pb-view-hot.js` → `pb-views.js` + extract PicksView — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the increment-7 spike file `pb-view-hot.js` to the generic bucket `pb-views.js`, then extract a second component (`PicksView`) into it — proving that adding a component to an existing bucket costs zero new harness/deploy wiring and that the `window.PBApp` bridge scales past its first consumer.

**Architecture:** Two behavior-green tasks, app green at every step. **Task 1** renames the file (`git mv`) and re-points every wiring reference (index.html, sw precache + cache bump, deploy allowlist, all 16 verify harnesses) **while `app.js` is untouched** — HotTopicsView still serves the Hot tab, so the app mounts identically; this isolates the one-time rename tax. **Task 2** moves `PicksView` verbatim from `app.js` into the `pb-views.js` IIFE, grows the `PBApp` bridge from 5→7 members, and replaces the `app.js` definition with a `const … = PBViews.PicksView` bind — `app.js`-only, zero new harness edits (the payoff). **Task 3** appends the measured read-out to the spec.

**Tech Stack:** Vanilla ES (no build step), React 18 via UMD global, hand-written `React.createElement` (no JSX), `node --check` + existing `node` suites for regression, headless-Chrome `verify-*.mjs` harnesses for mount/render smoke.

## Global Constraints

- **Byte-verbatim move via Node slice scripts — never the Edit tool, never retype.** `pb-views.js` (renamed from `pb-view-hot.js`) carries **literal** non-ASCII in HotTopicsView's comments/strings (box-drawing `─`, ellipsis `…`, middot `·`) and is **UTF-8 with a leading BOM (`﻿`) + CRLF (`\r\n`)**. `app.js` is likewise **BOM + CRLF** and authors non-ASCII as `\uXXXX`/`\xXX` ASCII escapes (PicksView's `p.name, " \xB7 ", p.sector` is already an escape). All content surgery uses Node scripts that read as `'utf8'` (keeps the BOM as the first char), `split('\r\n')` / `join('\r\n')`, and write as `'utf8'` (restores BOM bytes). All hand-written code in this plan is pure ASCII.
- **CRLF-safe manual edits:** the `index.html` / `sw.js` / `static.yml` edits in Task 1 are **single-line** string replacements (no `\n` inside the matched text), so CRLF vs LF is irrelevant. Everything multi-line goes through a Node script.
- **The bridge grows to exactly 7 members:** `window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt };`. `PriceBlock` (app.js:3782, a `React.memo` leaf) and `fmt` (app.js:1262, display helper) are added; both are used widely across `app.js` and **stay** there, reached through the bridge. The first five are unchanged from inc 7.
- **PicksView reaches globals directly, app.js-internals via the bridge.** Inside `PicksView`, `PriceBlock`/`fmt` come from `window.PBApp`; `DATA` is read as `const DATA = window.PB_DATA;` (the data.js global, mirroring `app.js:11` — **not** routed through `PBApp`); `PBStore.usePricesMap()` stays qualified. `PicksView` uses **no** React hooks, so no `useEffect`/`useRef` import is needed for it.
- **Load order is unchanged:** `pb-views.js` occupies the exact slot `pb-view-hot.js` had — after `pb-import.js`, before `data.js` in `index.html`, and before `app.js` everywhere (so `app.js`'s module-scope `const PicksView = PBViews.PicksView` bind resolves). Views read `window.PBApp`/`window.PB_DATA` lazily at render, so `app.js`/`data.js` loading later is a non-issue.
- **sw cache bump required, once — re-verify the current version at execution.** The in-flight fundamentals hotfix already moved `CACHE_NAME` to `playbook-shell-v54`, so increment 8 bumps to the **next** version (v54 → **v55** unless the landed value differs). At execution: `grep "const CACHE_NAME" sw.js`, then bump by one. The single bump in Task 1 covers both tasks. (The inc-7 plan's v52 is long stale.)
- **Rename wiring surface (the one-time tax):** `index.html` (1) + `sw.js` SHELL_ASSETS (1) + `sw.js` cache bump (1) + `.github/workflows/static.yml` (cp list + Guard-1 loop, 2) + all **16** app-mounting `backend/test/verify-*.mjs` harness shells (1 `<script>` each). No `.test.mjs` hardcodes the filename (`deploy-assets.test.mjs` derives the asset set dynamically), so the rename breaks no test assertion. No worker/wrangler impact (the worker bundles `pb-core`, never view code). `pb-core`/`pb-data`/`pb-store`/`pb-content`/`pb-import`/`data.js` untouched.
- **No node unit test is added.** A pure-UI view has no pure surface to node-test; nothing pure moves. Verification is `node --check` + the existing node suite staying green + the browser mount gate + a scratchpad Picks-tab render check.
- **Commits (subagent-driven run):** each task's implementer commits its own changes locally on branch `refactor/phase-4-increment-8-picks-view-bucketing`. Nothing is pushed. **Jan does the final PR/merge to main; in an inline run, Jan handles commits.** Scratchpad scripts and the render-check harness are throwaway — **not committed**.

**Test runner reference:** no npm script. Run one suite with `node backend/test/<name>.test.mjs`. Whole suite from repo root:
```bash
for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "ok  $f" || echo "FAIL $f"; done
```
The browser mount gate: `node backend/test/verify-refresh-behavior.mjs` (expects a final `ALL PASSED`). Chrome path is hardcoded in the harnesses: `C:\Program Files\Google\Chrome\Application\chrome.exe`.

---

### Task 1: Rename `pb-view-hot.js` → `pb-views.js` and re-point every wiring reference (behavior-neutral)

`app.js` is **not modified** in this task. The bucket file is renamed and every load path re-pointed, so the app must still mount and render identically (HotTopicsView still serves the Hot tab from the renamed file). This isolates the one-time rename tax.

**Files:**
- Rename: `pb-view-hot.js` → `pb-views.js` (repo root, via `git mv`)
- Create (throwaway, not committed): `scratchpad/inc8-rename-wiring.mjs`
- Modify: `pb-views.js` (header comment, via the script), `index.html` (1 line), `sw.js` (SHELL_ASSETS + CACHE_NAME), `.github/workflows/static.yml` (2 lines), all 16 `backend/test/verify-*.mjs` app-mounting shells (via the script)

**Interfaces:**
- Produces: the global script `pb-views.js` registering `window.PBViews.HotTopicsView` (unchanged behavior), loaded from the same slot the old filename occupied.
- Consumes: nothing from earlier tasks (first task).

- [ ] **Step 1: Create the increment branch**

Run (branch off the current HEAD, which is level with `origin/main`):
```bash
git checkout -b refactor/phase-4-increment-8-picks-view-bucketing
```
Expected: `Switched to a new branch 'refactor/phase-4-increment-8-picks-view-bucketing'`. (If it already exists, `git checkout refactor/phase-4-increment-8-picks-view-bucketing`.)

- [ ] **Step 2: Rename the file with git**

Run:
```bash
git mv pb-view-hot.js pb-views.js
node --check pb-views.js
```
Expected: no output from either (rename staged; `node --check` exits 0 — a rename doesn't change bytes).

- [ ] **Step 3: Write the rename-wiring script** `scratchpad/inc8-rename-wiring.mjs`

```js
// scratchpad/inc8-rename-wiring.mjs — run once from repo root; NOT committed.
// After `git mv pb-view-hot.js pb-views.js`: rewrite the file's 3-line header banner in place
// and re-point the 16 verify-*.mjs harness shells from /pb-view-hot.js to /pb-views.js.
// (index.html, sw.js, static.yml are edited separately as single-line replacements.)
// BOM + CRLF preserved (utf8 read/write, split/join '\r\n').
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 1) rewrite pb-views.js header (3 lines, in place — keeps line count, preserves the BOM on line 0)
{
  const p = 'pb-views.js';
  const lines = readFileSync(p, 'utf8').split('\r\n');
  const h = lines.findIndex(l => l.includes('HotTopicsView, extracted from app.js'));
  if (h < 0) throw new Error('pb-views.js header marker not found');
  const bom = lines[h].startsWith('﻿') ? '﻿' : '';
  lines[h]     = bom + '// pb-views.js - extracted view-component bucket (Phase 4). Browser-only classic script.';
  lines[h + 1] = '// Registers window.PBViews.<View> and reads shared app.js primitives from window.PBApp';
  lines[h + 2] = '// at render time (bridge). data.js/PBStore globals are read directly, not via the bridge.';
  writeFileSync(p, lines.join('\r\n'), 'utf8');
  console.log('rewrote pb-views.js header');
}

// 2) re-point the harness shells (global replace on each; CRLF-safe)
{
  const dir = 'backend/test';
  let n = 0;
  for (const f of readdirSync(dir).filter(f => /^verify-.*\.mjs$/.test(f))) {
    const fp = join(dir, f);
    const s = readFileSync(fp, 'utf8');
    if (!s.includes('/pb-view-hot.js')) continue;
    writeFileSync(fp, s.split('/pb-view-hot.js').join('/pb-views.js'), 'utf8');
    n++; console.log('re-pointed', f);
  }
  console.log('re-pointed', n, 'harnesses');
}
```

- [ ] **Step 4: Run the rename-wiring script**

Run:
```bash
node scratchpad/inc8-rename-wiring.mjs
node --check pb-views.js
```
Expected: prints `rewrote pb-views.js header`, 16 `re-pointed …` lines, then `re-pointed 16 harnesses`; `node --check` exits 0. If the count is not 16, stop — a harness list drifted; inspect before continuing.

- [ ] **Step 5: Re-point `index.html`** (single-line edit)

Edit `index.html`:
- old: `<script src="./pb-view-hot.js"></script>`
- new: `<script src="./pb-views.js"></script>`

- [ ] **Step 6: Re-point `sw.js` SHELL_ASSETS and bump the cache** (two single-line edits)

Edit `sw.js` — SHELL_ASSETS entry:
- old: `  './pb-view-hot.js',`
- new: `  './pb-views.js',`

Edit `sw.js` — cache bump. First re-check the current value (`grep "const CACHE_NAME" sw.js`); the in-flight fundamentals hotfix took it to `v54`, so bump to the next version:
- old: `const CACHE_NAME   = 'playbook-shell-v54';`
- new: `const CACHE_NAME   = 'playbook-shell-v55';`

(If the landed value differs from `v54`, bump *that* value by one instead — the point is one increment past whatever is committed.)

- [ ] **Step 7: Re-point `.github/workflows/static.yml`** (replace-all on the shared token)

Edit `.github/workflows/static.yml` with **replace-all** on `pb-view-hot.js` (it occurs twice — the `cp` allowlist and the Guard-1 loop):
- old (replace all): `pb-view-hot.js`
- new (replace all): `pb-views.js`

- [ ] **Step 8: Verify the rename is complete and consistent**

Run:
```bash
echo "old name still referenced anywhere? (expect 0):"; grep -rl "pb-view-hot" . --include=*.js --include=*.mjs --include=*.html --include=*.yml | grep -v node_modules | wc -l
echo "harnesses referencing /pb-views.js (expect 16):"; grep -l "/pb-views.js" backend/test/verify-*.mjs | wc -l
echo "static.yml pb-views.js (expect 2):"; grep -c "pb-views.js" .github/workflows/static.yml
echo "index.html pb-views.js (expect 1):"; grep -c "pb-views.js" index.html
echo "sw.js pb-views.js + v54 (expect 1 each):"; grep -c "'./pb-views.js'" sw.js; grep -c "playbook-shell-v54" sw.js
echo "app.js untouched (expect no output):"; git diff --name-only app.js
```
Expected: `0`, `16`, `2`, `1`, `1`, `1`, and no `app.js` line. If `pb-view-hot` still appears anywhere, re-point the straggler.

- [ ] **Step 9: Run the full node suite — must stay green**

Run:
```bash
for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "ok  $f" || echo "FAIL $f"; done
```
Expected: every line `ok` (money gate included). In particular `deploy-assets.test.mjs` must be `ok` — it cross-checks index.html ↔ SHELL_ASSETS ↔ allowlist, so a green result proves the three deploy touchpoints stayed in lockstep through the rename.

- [ ] **Step 10: Run the browser mount gate**

Run:
```bash
node backend/test/verify-refresh-behavior.mjs
```
Expected: final line `ALL PASSED`. Its shell now loads `pb-views.js`; the app must mount with no `PBViews`/`PBApp` ReferenceError, and the standing `holdings rows deliberately have NO session badge` guard must still hold.

- [ ] **Step 11: Commit** (SDD run; in an inline run Jan commits)

```bash
git add pb-views.js index.html sw.js .github/workflows/static.yml backend/test/verify-*.mjs
git commit -m "refactor(view): rename pb-view-hot.js -> pb-views.js + re-point wiring (behavior-neutral)"
```
Note: `git add pb-views.js` records the rename (git detects it from the staged `git mv` + content). Confirm with `git status` that no `pb-view-hot.js` remains.

---

### Task 2: Extract `PicksView` into `pb-views.js` and grow the `PBApp` bridge

Move `PicksView` out of `app.js` into the bucket, switch `app.js` to the global, and add the two bridge members it needs. After this task the New picks tab renders from `pb-views.js`, and the bucket holds two components.

**Files:**
- Modify: `app.js` (remove `PicksView` definition → one-line bind; grow the `window.PBApp` publish; fix the stale inc-7 bind comment), `pb-views.js` (gain `PicksView` + its registration)
- Create (throwaway, not committed): `scratchpad/inc8-extract-picks.mjs`, `scratchpad/inc8-picks-render.mjs`

**Interfaces:**
- Consumes: the `pb-views.js` global and its `window.PBViews` namespace from Task 1.
- Produces: `window.PBViews.PicksView` (a React function component with the `(_ref9)` signature and unchanged `{ onOpenDetail }` prop); grows `window.PBApp` to `{ Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt }`.

- [ ] **Step 1: Write the extract-and-flip script** `scratchpad/inc8-extract-picks.mjs`

```js
// scratchpad/inc8-extract-picks.mjs — run once from repo root; NOT committed.
// Moves PicksView verbatim app.js -> pb-views.js (injecting the bridge + PB_DATA reads),
// replaces the app.js definition with a bind, grows the PBApp bridge to 7 members, and
// fixes the inc-7 bind comment's stale filename. BOM + CRLF + \uXXXX escapes preserved.
import { readFileSync, writeFileSync } from 'node:fs';

// ---- app.js: slice PicksView out (ASCII markers) ----
const appLines = readFileSync('app.js', 'utf8').split('\r\n');
const pStart = appLines.findIndex(l => l.startsWith('function PicksView('));
if (pStart < 0) throw new Error('PicksView start marker not found');
const pEnd = appLines.findIndex((l, i) => i > pStart && l.startsWith('function HedgesView('));
if (pEnd < 0) throw new Error('HedgesView end marker not found');
const moved = appLines.slice(pStart, pEnd); // PicksView fn, verbatim

// inject the two lead reads immediately after the signature line
moved.splice(1, 0,
  '  const { PriceBlock, fmt } = window.PBApp;',
  '  const DATA = window.PB_DATA;');

// replace the app.js definition with a one-line bind (+ note)
appLines.splice(pStart, pEnd - pStart,
  '// PicksView is defined in pb-views.js (Phase 4 inc 8); bind it here.',
  'const PicksView = PBViews.PicksView;');

// grow the PBApp bridge (fresh index — the line moved up after the splice above)
const bridgeIdx = appLines.findIndex(l => l.startsWith('window.PBApp = {'));
if (bridgeIdx < 0) throw new Error('PBApp publish marker not found');
appLines[bridgeIdx] = 'window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt };';

// fix the inc-7 bind comment's stale filename (HotTopicsView note still says pb-view-hot.js)
const cmtIdx = appLines.findIndex(l => l.includes('HotTopicsView is defined in pb-view-hot.js'));
if (cmtIdx >= 0) appLines[cmtIdx] = appLines[cmtIdx].split('pb-view-hot.js').join('pb-views.js');

writeFileSync('app.js', appLines.join('\r\n'), 'utf8');

// ---- pb-views.js: insert PicksView before the registration block, then register it ----
const vLines = readFileSync('pb-views.js', 'utf8').split('\r\n');
const regIdx = vLines.findIndex(l => l.includes('window.PBViews = window.PBViews'));
if (regIdx < 0) throw new Error('PBViews registration marker not found');
vLines.splice(regIdx, 0, '', '// --- New picks (moved from app.js, Phase 4 inc 8) ---', ...moved);
const hotRegIdx = vLines.findIndex(l => l.includes('window.PBViews.HotTopicsView = HotTopicsView'));
if (hotRegIdx < 0) throw new Error('HotTopicsView registration marker not found');
vLines.splice(hotRegIdx + 1, 0, '  window.PBViews.PicksView = PicksView;');
writeFileSync('pb-views.js', vLines.join('\r\n'), 'utf8');

console.log('inc8: moved', moved.length, 'lines (incl. 2 injected); pb-views.js now', vLines.length, 'lines');
```

- [ ] **Step 2: Run the script and syntax-check both files**

Run:
```bash
node scratchpad/inc8-extract-picks.mjs
node --check app.js
node --check pb-views.js
```
Expected: prints the move confirmation (`moved` ≈ 64 lines); both `node --check` exit 0. If either fails, the markers are wrong — inspect and fix the script, do not hand-edit the files.

- [ ] **Step 3: Verify the source now delegates (anti-drift by grep)**

Run:
```bash
grep -c "const PicksView = PBViews.PicksView" app.js                                  # expect 1
grep -c "window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt }" app.js  # expect 1
grep -c "^function PicksView(_ref9)" app.js                                           # expect 0 (moved out)
grep -c "pb-view-hot" app.js                                                          # expect 0 (comment fixed)
grep -c "^function PicksView(_ref9)" pb-views.js                                      # expect 1 (moved in)
grep -c "window.PBViews.PicksView = PicksView" pb-views.js                            # expect 1
grep -c "const { PriceBlock, fmt } = window.PBApp" pb-views.js                        # expect 1
grep -c "const DATA = window.PB_DATA" pb-views.js                                     # expect 1
```
Expected: `1, 1, 0, 0, 1, 1, 1, 1`. Confirms the definition moved, the bind + grown bridge are in place, the stale comment is fixed, and the bridge/DATA reads were injected exactly once. (`PriceBlock`/`fmt` definitions remain in `app.js` — only bridged, not moved.)

- [ ] **Step 4: Run the full node suite — must stay green**

Run:
```bash
for f in backend/test/*.test.mjs; do node "$f" >/dev/null 2>&1 && echo "ok  $f" || echo "FAIL $f"; done
```
Expected: every line `ok`. No money/logic changed by a UI move; suites are unaffected.

- [ ] **Step 5: Run the browser mount gate**

Run:
```bash
node backend/test/verify-refresh-behavior.mjs
```
Expected: final line `ALL PASSED`. App mounts with `app.js` binding `PBViews.PicksView` and publishing the grown `PBApp`; no ReferenceError; holdings-no-badge guard holds. (The Picks tab is not opened here — the next step covers it.)

- [ ] **Step 6: Write the Picks-tab render check** `scratchpad/inc8-picks-render.mjs`

This is the check the mount gate cannot cover: `viewMap` builds `React.createElement(PicksView, …)` eagerly every render but only *renders* it on the active tab, so a broken bind yields an `undefined` type that only fails when that tab is opened. Adapted from `verify-refresh-behavior.mjs` (same server/Chrome/CDP boilerplate); its script list includes `/pb-views.js`. It also re-checks the Hot tab (rename regression).

```js
// scratchpad/inc8-picks-render.mjs — run once from repo root; NOT committed.
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
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failures++; };
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
```

- [ ] **Step 7: Run the Picks-tab render check**

Run:
```bash
node scratchpad/inc8-picks-render.mjs
```
Expected: final line `ALL PASSED` — app mounts, both views registered, `PBApp` grown, the Hot tab still renders (rename regression clear), the Picks tab renders ≥1 `.pos-card`, and the moved copy renders without mojibake. If `.pos-card` count is 0, the bind is broken — re-check Step 3 and that `pb-views.js` is in the harness script list above.

- [ ] **Step 8: Commit** (SDD run; in an inline run Jan commits)

```bash
git add app.js pb-views.js
git commit -m "refactor(view): extract PicksView into pb-views.js bucket; grow PBApp bridge to 7"
```

---

### Task 3: Append the measured read-out to the spec

Record the bucketing economics this increment set out to demonstrate, beside the design.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-12-phase-4-increment-8-picks-view-bucketing-design.md` (append a "Measured read-out" section)

**Interfaces:** none (documentation).

- [ ] **Step 1: Measure the actual deltas**

Run:
```bash
echo "app.js delta vs branch point:"; git diff --stat main -- app.js 2>/dev/null || git diff --stat HEAD~2 -- app.js
echo "pb-views.js size:"; wc -l pb-views.js
echo "bridge members:"; grep -o "window.PBApp = {[^}]*}" app.js
echo "views in bucket:"; grep -c "window.PBViews\." pb-views.js
```
Record: the `app.js` line delta (≈ −60), `pb-views.js` size (≈ 220), the bridge member count (7), and the bucket now holding 2 views.

- [ ] **Step 2: Append the read-out to the spec**

Append this section (fill the bracketed numbers from Step 1) to `docs/superpowers/specs/2026-07-12-phase-4-increment-8-picks-view-bucketing-design.md`:

```markdown
## Measured read-out (filled after execution)

**Bucketing economics, measured:**
- **Rename tax (one-time):** [N] wiring edits across [N] files — index.html (1), sw SHELL_ASSETS (1),
  sw cache bump v53→v54 (1), static.yml cp-list + Guard-1 (2), 16 harness shells (16). `app.js` was
  untouched in Task 1 (verified: empty `git diff --name-only app.js`), so the rename was provably
  behavior-neutral; `deploy-assets.test.mjs` stayed green, confirming the three deploy touchpoints
  re-pointed in lockstep.
- **PicksView add (the payoff):** `app.js`-only — remove fn, add bind, grow `PBApp` by 2 members.
  **Zero** new harness / sw-asset / static.yml / index.html edits. `app.js` [−N] lines; `pb-views.js`
  [+N] lines; bucket now holds **2** components.
- **Bridge:** `window.PBApp` grew 5 → **7** (`+PriceBlock`, `+fmt`). The bridge-vs-global split held:
  `PicksView` reached `DATA` via `window.PB_DATA` directly and `PBStore` qualified, so only genuine
  app.js-internals entered `PBApp` — [note whether the grab-bag felt manageable at 7].
- **Verification friction:** unchanged from inc 7 — no node test possible; the eager `viewMap`
  createElement meant a broken bind was invisible to the mount gate, so the Picks-tab render check was
  mandatory. It caught [nothing / any issue found].

**Conclusion:** the read-out's thesis holds — the per-component cost inside an existing bucket is
`app.js`-only. Next increment: extract `HedgesView` (same `PriceBlock`+`fmt`+`DATA` shape) as a
near-free add with **zero** new `PBApp` members, further amortizing the (already-paid) bucket wiring.
```

- [ ] **Step 3: Commit** (SDD run; in an inline run Jan commits)

```bash
git add docs/superpowers/specs/2026-07-12-phase-4-increment-8-picks-view-bucketing-design.md
git commit -m "docs(inc8): measured read-out — rename tax vs cheap bucket-add"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- Goal / scope (rename to pb-views.js, extract PicksView, bucketing) → Tasks 1–2.
- Dependency inventory (bridge `PriceBlock`/`fmt`; read `window.PB_DATA` directly; `PicksView` uses no hooks) → Task 2 Step 1 (injected lead reads + bridge grow), verified Task 2 Step 3.
- Bridge-vs-global distinction → Global Constraints + Task 2 Step 1 (DATA read direct, PriceBlock/fmt bridged) + render check Step 6 (`PBApp.PriceBlock`/`fmt` asserted).
- Mechanism (`pb-views.js` IIFE with two views; `app.js` bind + grown `PBApp`; TDZ-safe const bind) → Task 2 Steps 1–3.
- Extraction discipline (verbatim slice, BOM/CRLF, `\uXXXX`/`\xXX`, only-edited-lines are the two injected reads) → Global Constraints + Task 2 Step 1 script.
- Wiring — rename surface (index.html, sw SHELL_ASSETS + v53→v54, static.yml ×2, 16 harnesses) → Task 1 Steps 2–8; extraction adds zero → Task 2 (app.js + pb-views.js only).
- Verification gate (node --check both, node suite incl. deploy-assets + money gate, mount gate, **Picks-tab render check** + Hot regression + encoding sanity) → Task 1 Steps 9–10, Task 2 Steps 2–7.
- Deliverable (measured read-out) → Task 3.
- Out-of-scope (no HedgesView, no modal, no pb-core push, no Context, no Vite) → honored; none implemented.

**Placeholder scan:** No "TBD"/"handle errors"/"similar to Task N". The read-out template in Task 3 Step 2 has bracketed numbers **by design** — filled from the explicit Task 3 Step 1 measurement. All code steps show complete code.

**Type/name consistency:** `window.PBViews.PicksView`, `const PicksView = PBViews.PicksView`, and `window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt }` are spelled identically in the extract script (Task 2 Step 1), the anti-drift greps (Task 2 Step 3), and the render check (Task 2 Step 6). The injected `const { PriceBlock, fmt } = window.PBApp;` matches the grown `PBApp` publish member-for-member; `const DATA = window.PB_DATA;` matches `app.js:11`. Cache `v53`→`v54` and harness count `16` are consistent throughout. Markers `function PicksView(` / `function HedgesView(` / `window.PBApp = {` / `window.PBViews = window.PBViews` / `window.PBViews.HotTopicsView = HotTopicsView` are used identically in the extract script and verified by the greps.
