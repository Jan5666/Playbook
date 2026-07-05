# Phase 3 increment 5 — memo / identity stabilization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the callback identities `App` hands to children so the already-`React.memo`'d
`HoldingRow` stops re-rendering on unrelated `App` renders, and remove the increment-4-flagged
`withToast` wrapper churn — behaviour identical throughout.

**Architecture:** Two edge-only pieces, both inside `App`. **Piece 1:** replace the per-render
`withToast` factory + ~34 wrappers with one ref-backed helper `useToastEvents(impls, toast)` that
returns stable-identity, toast-at-edge wrappers for the portfolio/push/backup actions. **Piece 2:**
`useCallback` the four inline UI handlers that actually reach `HoldingRow` (`openDetail` + the
buy/sell/edit modal-openers) so its memo bites. Data-layer hook bodies are untouched.

**Tech Stack:** Browser global scripts (no build step), React 18 via `React.createElement`, `PBStore`
collections, Node's built-in `node:test` + `node:vm` for tests, Puppeteer browser smokes.

## Global Constraints

- All code changes land in **`app.js`** and **`sw.js`**. `pb-core.js`, `pb-data.js`, `pb-store.js` are
  **untouched**. No `usePortfolio`/`usePushBackend`/`usePriceFeed`/`saveBackupFile` **body** change.
- **No new runtime files** → **no** `index.html` / deploy-allowlist / precache change. **No**
  worker/`wrangler` impact.
- `sw.js` `CACHE_NAME` is bumped **exactly once**: `playbook-shell-v43` → `playbook-shell-v44` (Task 3).
- **Behaviour identical.** No message wording change, no cadence change, no money-math change. The money
  gate (`money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse`) must pass **unchanged**.
- `app.js` ships **CRLF**. The Edit tool normalizes CRLF on match, so `\n`-based `old_string` works.
  Test source-slice markers must be single-token (avoid multi-line `\n` spans); `src.indexOf('\n}',
  start)` is CRLF-safe and lands on a **column-0** `}` (top-level function close).
- Test runner: no npm script. Run a suite with `node backend/test/<name>.test.mjs`.
- **Execution = subagent-driven with per-task commits on this local branch only** (confirmed with Jan,
  matching increment 4). Each task commits its own work; **never `push` or `git merge`** — the final
  PR/merge is Jan's. Leave Jan's incidental uncommitted noise (e.g. `.claude/settings.json`, regenerated
  `test-screenshots/*.png`) unstaged; commit only the files your task changes.
- Preconditions (verify before Task 1): on branch `refactor/phase-3-increment-5-memo-identity` cut from
  `origin/main` `716d5f8` (increment 4 merged as PR #14); working tree clean.

---

## Task 1: `useToastEvents` helper + Piece 1 edge stabilization

**Files:**
- Modify: `app.js` — add `useToastEvents` (before `ToastContext`, ~L2710); replace the `withToast`
  factory + 30 portfolio wrappers (~L2954–3006); replace the 3 push wrappers (~L3249–3251); update the
  backup caller (~L3348).
- Test: `backend/test/toast-copy.test.mjs` — replace the existing `withToast` anti-drift test (L103–107)
  with Piece-1 guards.

**Interfaces:**
- Consumes: `describeOutcome` (already in `app.js`); `useRef`/`useLayoutEffect`/`useMemo` (already
  destructured from `React` at `app.js:3–10`).
- Produces: `useToastEvents(impls, toast) → { [name]: stableFn }` — top-level hook; each returned fn has
  a fixed identity, calls the latest `impls[name]`, and toasts `describeOutcome(result)` at the edge
  (async-aware; returns the impl's own value unchanged).

- [ ] **Step 1: Replace the failing anti-drift test**

In `backend/test/toast-copy.test.mjs`, replace the whole test block (currently L103–107):

```javascript
test('anti-drift: App defines withToast and calls usePortfolio(fxRates)', () => {
  assert.ok(/const withToast = useCallback\(/.test(src), 'App should define withToast via useCallback');
  assert.ok(/usePortfolio\(fxRates\)/.test(src), 'App should call usePortfolio(fxRates) (no toast arg)');
  assert.ok(!/usePortfolio\(fxRates, toast\)/.test(src), 'the old usePortfolio(fxRates, toast) call must be gone');
});
```

with:

```javascript
test('anti-drift: Piece 1 — useToastEvents replaces the per-render withToast wrappers', () => {
  // the standalone withToast factory and all its per-render wrappers are gone
  assert.ok(!/const withToast = useCallback\(/.test(src), 'the standalone withToast useCallback helper must be gone');
  assert.ok(!/=\s*withToast\(/.test(src), 'no per-render withToast(...) wrappers may remain');
  // the helper exists and builds its wrappers once, keeping impls+toast current via refs
  assert.ok(/function useToastEvents\(impls, toast\)\s*\{/.test(src), 'useToastEvents(impls, toast) helper should exist');
  const body = sliceFn('function useToastEvents(');
  assert.ok(body && /useMemo\(\(\)\s*=>/.test(body) && /\},\s*\[\]\);/.test(body),
    'useToastEvents should build its wrappers in a useMemo([]) (stable identity)');
  assert.ok(body && /implsRef\.current\s*=\s*impls/.test(body) && /toastRef\.current\s*=\s*toast/.test(body),
    'useToastEvents should keep impls + toast current via refs');
  // App wires actions through the helper and still calls usePortfolio at the CALL SITE (fixes nit #2)
  assert.ok(/useToastEvents\(/.test(src), 'App should wire actions through useToastEvents(...)');
  assert.ok(/const _p = usePortfolio\(fxRates\);/.test(src), 'App should call usePortfolio(fxRates) at the call site');
  assert.ok(!/usePortfolio\(fxRates, toast\)/.test(src), 'the old usePortfolio(fxRates, toast) call must be gone');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node backend/test/toast-copy.test.mjs`
Expected: FAIL — `useToastEvents(impls, toast) helper should exist` (and the "withToast helper must be
gone" assertions) fail, because the code still has `withToast` and no `useToastEvents`.

- [ ] **Step 3: Add the `useToastEvents` helper**

Insert immediately **above** `const ToastContext = React.createContext(() => {});` (`app.js` ~L2710):

```javascript
// ─── Stable edge action wrappers ──────────────────────────────────────────────
// Given an object of (possibly-churning) action impls, return an object of
// STABLE-identity wrappers. Each wrapper always calls the latest impl and toasts
// describeOutcome(result) at the edge — impls + toast are read through refs so the
// wrapper identities never change (latest-ref / useEffectEvent pattern). Built once,
// so the wrappers are safe to hand to React.memo'd children. Async impls toast after
// they resolve and the wrapper returns the impl's own value unchanged.
function useToastEvents(impls, toast) {
  const implsRef = useRef(impls); useLayoutEffect(() => { implsRef.current = impls; });
  const toastRef = useRef(toast); useLayoutEffect(() => { toastRef.current = toast; });
  return useMemo(() => {
    const out = {};
    for (const name of Object.keys(implsRef.current)) {
      out[name] = (...args) => {
        const r = implsRef.current[name](...args);
        if (r && typeof r.then === 'function')
          return r.then(o => { const m = describeOutcome(o); if (m) toastRef.current(m); return o; });
        const m = describeOutcome(r); if (m) toastRef.current(m);
        return r;
      };
    }
    return out;
  }, []);
}
```

- [ ] **Step 4: Replace the portfolio edge**

Replace the block from `  // withToast: the edge. Run a data-layer action, map its { ok, code, ... }
outcome` (~L2954) through `  const removeAlert = withToast(_p.removeAlert);` (~L3006) — i.e. the
`withToast` doc-comment, the `withToast` `useCallback`, the `const _p = usePortfolio(fxRates);` call,
the reads destructure, and all 30 wrapper lines — with:

```javascript
  const _p = usePortfolio(fxRates);
  // Reactive reads pass straight through — they must change every render.
  const {
    positions, watchlist, watchlistGroups, alerts, contributions, transactions,
    tfsaDeposits, sectorCache, sectorWeights, previewLoadError,
  } = _p;
  // Stable-identity action wrappers (built once) so memo'd leaves skip re-render on
  // unrelated App renders. Each wrapper toasts describeOutcome at the edge and always
  // calls the latest underlying mutator. Push + backup get the same treatment below.
  const {
    setPositions, setWatchlist, setWatchlistGroups, setContributions, setTransactions,
    setTfsaDeposits, setSectorWeights, setSectorWeightsFor, setAlerts, setSectorCache,
    addPosition, updatePosition, removePosition, removePositions, sellPosition, importPositions,
    addContribution, removeContribution, importContributions, addTfsaDeposit, updateTfsaDeposit,
    removeTfsaDeposit, removeTfsaDeposits, addWatch, removeWatch, moveWatch, toggleWatchList,
    addWatchGroup, renameWatchGroup, removeWatchGroup, addAlert, removeAlert,
  } = useToastEvents({
    setPositions: _p.setPositions, setWatchlist: _p.setWatchlist,
    setWatchlistGroups: _p.setWatchlistGroups, setContributions: _p.setContributions,
    setTransactions: _p.setTransactions, setTfsaDeposits: _p.setTfsaDeposits,
    setSectorWeights: _p.setSectorWeights, setSectorWeightsFor: _p.setSectorWeightsFor,
    setAlerts: _p.setAlerts, setSectorCache: _p.setSectorCache,
    addPosition: _p.addPosition, updatePosition: _p.updatePosition,
    removePosition: _p.removePosition, removePositions: _p.removePositions,
    sellPosition: _p.sellPosition, importPositions: _p.importPositions,
    addContribution: _p.addContribution, removeContribution: _p.removeContribution,
    importContributions: _p.importContributions, addTfsaDeposit: _p.addTfsaDeposit,
    updateTfsaDeposit: _p.updateTfsaDeposit, removeTfsaDeposit: _p.removeTfsaDeposit,
    removeTfsaDeposits: _p.removeTfsaDeposits, addWatch: _p.addWatch,
    removeWatch: _p.removeWatch, moveWatch: _p.moveWatch, toggleWatchList: _p.toggleWatchList,
    addWatchGroup: _p.addWatchGroup, renameWatchGroup: _p.renameWatchGroup,
    removeWatchGroup: _p.removeWatchGroup, addAlert: _p.addAlert, removeAlert: _p.removeAlert,
  }, toast);
```

(The `useEffect` for `previewLoadError` immediately below, and `const toast = useToast();` immediately
above, are left untouched.)

- [ ] **Step 5: Replace the push wrappers + fold in backup**

Replace these three lines (~L3249–3251):

```javascript
  const connectPush = withToast(_connectPush);
  const testPush = withToast(_testPush);
  const disconnectPush = withToast(_disconnectPush);
```

with:

```javascript
  const { connectPush, testPush, disconnectPush, saveBackup } = useToastEvents({
    connectPush: _connectPush, testPush: _testPush, disconnectPush: _disconnectPush,
    saveBackup: saveBackupFile,
  }, toast);
```

- [ ] **Step 6: Update the backup caller**

Replace (~L3348):

```javascript
    withToast(saveBackupFile)(JSON.stringify(gatherBackup(), null, 2));
```

with:

```javascript
    saveBackup(JSON.stringify(gatherBackup(), null, 2));
```

- [ ] **Step 7: Syntax-check and run the anti-drift test**

Run: `node --check app.js && node backend/test/toast-copy.test.mjs`
Expected: `node --check` clean (exit 0); the Piece-1 test now PASSES along with the pre-existing
`describeOutcome` + hook anti-drift tests. (The `usePortfolio`/`usePushBackend`/`usePriceFeed`/
`saveBackupFile` "no toast param / no toast()" guards still pass — their bodies were not touched.)

- [ ] **Step 8: Browser smoke — toasts still fire, app mounts**

Run: `node backend/test/verify-refresh-behavior.mjs && node backend/test/verify-settings.mjs`
Expected: `verify-refresh-behavior` PASS (app mounts, "Today" P/L pill, no `useToastEvents`/`withToast`
ReferenceError). `verify-settings` PASS except the pre-existing "Alerts: menu overflows" fail. Re-run
once if the known flaky CDP "Execution context destroyed" race hits; the assertion checks are the gate.

---

## Task 2: Piece 2 — stabilize the memo-leaf UI handlers

**Files:**
- Modify: `app.js` — `openDetail` (~L3371) → `useCallback`; hoist `onEditPosition`/`onBuyPosition`/
  `onSellPosition` to `useCallback` consts (define once near `openDetail`); reference them in both
  viewProps blocks (dashboard/holdings ~L3420–3423 and `TFSAView` ~L3457–3459).
- Test: `backend/test/toast-copy.test.mjs` — append Piece-2 guards.

**Interfaces:**
- Consumes: `loadHistory`/`loadNews`/`loadFundamentals` (already `useCallback`'d at ~L3295/3299/3367);
  the stable setters `setSelected`, `setPosModalEditId`, `setPosModalOpen`, `setBuyModalPos`,
  `setSellModalPos`.
- Produces: stable `openDetail`, `onEditPosition`, `onBuyPosition`, `onSellPosition` — the four
  `HoldingRow` callback props.

- [ ] **Step 1: Write the failing anti-drift test**

Append to `backend/test/toast-copy.test.mjs`:

```javascript
// ── anti-drift: Piece 2 — memo-leaf UI handlers are stable ────────────────────
test('anti-drift: openDetail + buy/sell/edit handlers are useCallback (memo-leaf stable)', () => {
  assert.ok(/const openDetail = useCallback\(/.test(src), 'openDetail should be a useCallback');
  assert.ok(/const onEditPosition = useCallback\(pos =>/.test(src), 'onEditPosition should be a hoisted useCallback');
  assert.ok(/const onBuyPosition = useCallback\(pos =>/.test(src), 'onBuyPosition should be a hoisted useCallback');
  assert.ok(/const onSellPosition = useCallback\(pos =>/.test(src), 'onSellPosition should be a hoisted useCallback');
  // the viewProps blocks must reference the stable consts, not re-declare inline arrows
  assert.ok(!/onBuyPosition:\s*pos =>/.test(src), 'no inline onBuyPosition arrow may remain in viewProps');
  assert.ok(!/onSellPosition:\s*pos =>/.test(src), 'no inline onSellPosition arrow may remain in viewProps');
  assert.ok(!/onEditPosition:\s*pos =>\s*\{/.test(src), 'no inline onEditPosition arrow may remain in viewProps');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node backend/test/toast-copy.test.mjs`
Expected: FAIL — `openDetail should be a useCallback` (and the hoisted-const assertions) fail; the
inline arrows still match.

- [ ] **Step 3: Wrap `openDetail` in `useCallback`**

Change `openDetail` (~L3371). Replace the header line:

```javascript
  const openDetail = (ticker, market, opts) => {
```

with:

```javascript
  const openDetail = useCallback((ticker, market, opts) => {
```

and its closing `  };` (~L3389) with:

```javascript
  }, [loadHistory, loadNews, loadFundamentals]);
```

(Body unchanged. `setSelected`/`indicatorFor` are stable; the three `load*` are `useCallback`'d, so
`openDetail` is stable.)

- [ ] **Step 4: Hoist the three modal-opener handlers**

Immediately **after** the `openDetail` definition (after its new `}, [loadHistory, loadNews,
loadFundamentals]);`), add:

```javascript
  // Stable modal-openers shared by every view's HoldingRow (close over stable setters only),
  // so HoldingRow's React.memo skips rows whose data is unchanged.
  const onEditPosition = useCallback(pos => { setPosModalEditId(pos.id); setPosModalOpen(true); }, []);
  const onBuyPosition = useCallback(pos => setBuyModalPos(pos), []);
  const onSellPosition = useCallback(pos => setSellModalPos(pos), []);
```

- [ ] **Step 5: Reference the hoisted consts in both viewProps blocks**

In the dashboard/holdings viewProps block, replace (~L3420, 3422, 3423):

```javascript
      onEditPosition: pos => { setPosModalEditId(pos.id); setPosModalOpen(true); },
      onImportPositions: () => { setImportMarket(marketFilter); setShowImport(true); },
      onBuyPosition: pos => setBuyModalPos(pos),
      onSellPosition: pos => setSellModalPos(pos)
```

with:

```javascript
      onEditPosition: onEditPosition,
      onImportPositions: () => { setImportMarket(marketFilter); setShowImport(true); },
      onBuyPosition: onBuyPosition,
      onSellPosition: onSellPosition
```

In the `TFSAView` viewProps block, replace (~L3457–3459):

```javascript
      onEditPosition: pos => { setPosModalEditId(pos.id); setPosModalOpen(true); },
      onBuyPosition: pos => setBuyModalPos(pos),
      onSellPosition: pos => setSellModalPos(pos),
```

with:

```javascript
      onEditPosition: onEditPosition,
      onBuyPosition: onBuyPosition,
      onSellPosition: onSellPosition,
```

(`onOpenDetail: openDetail` in both blocks is already a reference — no change. `onAddPosition` stays
inline in both — it differs per view and is not a `HoldingRow` prop.)

- [ ] **Step 6: Syntax-check and run the anti-drift test**

Run: `node --check app.js && node backend/test/toast-copy.test.mjs`
Expected: `node --check` clean; the Piece-2 test PASSES (and all prior tests remain green).

- [ ] **Step 7: Browser smoke — holdings + handlers still work**

Run: `node backend/test/verify-holdings-redesign.mjs`
Expected: PASS — US/JSE/TFSA holdings render with correct avg-cost; `HoldingRow` and its
detail/buy/sell/edit handlers still function. Re-run once if the flaky CDP race hits.

---

## Task 3: Memo audit + test nit #1 + cache bump + full verification + handoff

**Files:**
- Modify: `backend/test/toast-copy.test.mjs` — narrow the over-broad `addPosition` C4 slice (nit #1).
- Modify: `sw.js:2` (`CACHE_NAME`).

**Interfaces:**
- Consumes: Tasks 1–2 complete.

- [ ] **Step 1: Memo audit (document; expected no code change)**

Confirm the three existing memos now have stable inputs and decide on any additional memo:
- `HoldingRow` — memo'd; all four handlers stable (Task 2); `position`/`quote`/`rates` ref-stable → bites.
- `PriceBlock`, `SessionBadge` — data-only props; already bite.
- Audit other **existing standalone** leaf components for now-fully-stable props. Do **not** extract
  inline-mapped rows into new components (Phase 4). Expected outcome: no new `React.memo` is warranted;
  record that in the handoff. If a component genuinely qualifies (all props stable), wrap it and note it.

- [ ] **Step 2: Narrow the over-broad `addPosition` C4 test slice (nit #1)**

In `backend/test/toast-copy.test.mjs`, replace the C4 test (currently ~L109–114):

```javascript
test('anti-drift: addPosition reads live store for C4, not the stale closure', () => {
  const body = sliceFn('const addPosition = async');
  assert.ok(body && /PBStore\.getCollection\('positions'\)/.test(body),
    'addPosition should derive existed from the live store');
  assert.ok(body && !/toast\(positions\.find/.test(body), 'the C4 stale-closure toast must be gone');
});
```

with a version that pins the specific C4 read line instead of slicing the whole mutator body:

```javascript
test('anti-drift: addPosition derives existed from the live store (C4), not a stale closure', () => {
  // pin the exact C4 read rather than slicing the whole (large) addPosition body
  assert.ok(/existedBefore\s*=\s*\(PBStore\.getCollection\('positions'\)/.test(src),
    "addPosition should derive existedBefore from PBStore.getCollection('positions')");
  assert.ok(!/toast\(positions\.find/.test(src), 'the C4 stale-closure toast must be gone');
});
```

(If the exact `existedBefore = (PBStore.getCollection('positions')` text differs in the source, adjust
the regex to match the actual C4 line verbatim — the intent is a narrow, line-specific assertion.)

- [ ] **Step 3: Run the test suite file**

Run: `node backend/test/toast-copy.test.mjs`
Expected: PASS — all `describeOutcome`, Piece-1, Piece-2, hook anti-drift, and the narrowed C4 test green.

- [ ] **Step 4: Bump the service-worker cache version**

In `sw.js` line 2, change `const CACHE_NAME   = 'playbook-shell-v43';` to
`const CACHE_NAME   = 'playbook-shell-v44';`.

- [ ] **Step 5: Syntax-check both changed scripts**

Run: `node --check app.js && node --check sw.js`
Expected: no output, exit 0.

- [ ] **Step 6: Run the full node test suite**

Run: `for f in backend/test/*.test.mjs; do echo "== $f =="; node "$f" || exit 1; done`
Expected: every suite green, including `toast-copy.test.mjs`. The money gate (`money-math`,
`cost-basis`, `import-matching`, `ee-ocr-parse`) passes **unchanged** — no formula or mutator body
was touched.

- [ ] **Step 7: Run the reliable browser smokes**

Run: `node backend/test/verify-refresh-behavior.mjs && node backend/test/verify-holdings-redesign.mjs && node backend/test/verify-settings.mjs`
Expected: all PASS (only the pre-existing `verify-settings` "Alerts: menu overflows" fail is allowed).
Re-run any that hit the known flaky CDP "Execution context destroyed" race — it is environmental.

- [ ] **Step 8: Hand off to Jan**

The per-task commits are already on the local branch; do **not** push or merge. Summarize for Jan:
files changed (`app.js`, `sw.js`, `backend/test/toast-copy.test.mjs`); the two pieces (edge
`useToastEvents` stabilization; memo-leaf handler stabilization so `HoldingRow`'s memo bites); the
memo-audit outcome; test results (full node suite green incl. the unchanged money gate; browser smokes
baseline-equivalent); and that this **completes Phase 3**. Jan reviews the branch and does the final
PR/merge.

---

## Self-review notes

- **Spec coverage:** Piece 1 `useToastEvents` + edge rewrite (Task 1); Piece 2 handler stabilization
  (Task 2); memo audit + minimal breadth (Task 3 Step 1); the 2 test nits — nit #2 (call-site
  assertion) in Task 1 Step 1, nit #1 (narrow C4 slice) in Task 3 Step 2; sw bump / no-new-file /
  no-worker-impact (Global + Task 3); sound-by-construction verification via guards + smokes (each task).
- **Placeholder scan:** none — every code step shows the exact new code and the anchor it replaces.
- **Type consistency:** `useToastEvents(impls, toast)` is defined in Task 1 and referenced by the same
  signature in the Task-1 guards; the four Piece-2 consts (`openDetail`, `onEditPosition`,
  `onBuyPosition`, `onSellPosition`) are defined in Task 2 Steps 3–4 and referenced by the same names in
  Step 5 and the Task-2 guards. `sliceFn` is the existing helper in `toast-copy.test.mjs` (Task 1 reuses
  it). `CACHE_NAME` v43→v44 is bumped exactly once (Task 3).
- **Known non-goal:** no new-component extraction, no store self-subscription rework, no hook/money
  changes — those are Phase 4 / out of scope.
