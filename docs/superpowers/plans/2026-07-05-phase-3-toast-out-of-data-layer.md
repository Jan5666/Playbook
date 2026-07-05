# Phase 3 — Toast out of the data layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every user-facing `toast()` call from the state/mutation hooks so the data
layer reports typed outcomes and a single edge (`App`) owns all copy and renders the toast.

**Architecture:** Mutators/actions return `{ ok, code, ...data }` outcomes. A pure
`describeOutcome(outcome)` maps `code`(+data) → copy in one place. `App` wraps each action with a
promise-aware `withToast(fn)` helper that toasts `describeOutcome(outcome)` after the action
runs. Ambient price-feed status becomes an `App` effect over the exposed `failStreak`.

**Tech Stack:** Browser global scripts (no build step), React 18 via `React.createElement`,
`PBStore` collections, Node's built-in `node:test` + `node:vm` for tests.

## Global Constraints

- All changes land in `app.js`. `pb-core.js`, `pb-data.js`, `pb-store.js` are **untouched**.
- **No** new files → **no** `index.html` / deploy-allowlist / precache change. **No** worker/`wrangler` impact.
- `sw.js` `CACHE_NAME` is bumped **exactly once**: `playbook-shell-v42` → `playbook-shell-v43` (Task 5).
- Message wording is preserved **except** two approved changes: (1) the two price-feed toasts
  collapse to one — `'Price feed unreachable — showing last known prices'` on `failStreak === 2`;
  the separate `'Price refresh failed'` is dropped. (2) minor wording unification inside
  `describeOutcome` is allowed.
- `app.js` ships with CRLF line endings. The Edit tool normalizes CRLF when matching, so
  `\n`-based `old_string` works. Test source-slice markers must be single-token (avoid multi-line
  `\n` spans); `src.indexOf('\n}', start)` is CRLF-safe.
- Test runner: no npm script. Run a suite with `node backend/test/<name>.test.mjs`.
- **Commits and merges are Jan's.** Build + verify in the working tree only; never `git commit`
  or `git merge`. The final step hands off to Jan.
- Preconditions (verify before Task 1): the working tree is clean on a branch cut from the latest
  `origin/main` (Phase 3 inc 3b merged as PR #11). Any in-flight `feature/seven-item-update`
  changes must already be landed or stashed.

---

## Task 1: `describeOutcome` copy map + unit test

**Files:**
- Modify: `app.js` (add `describeOutcome` as a top-level fn immediately above
  `const ToastContext = React.createContext(() => {});` — currently ~L2679)
- Test: `backend/test/toast-copy.test.mjs` (create)

**Interfaces:**
- Produces: `describeOutcome(outcome) → string | null` — pure, self-contained (no external refs).
  Returns `null` for `null`/undefined/`{}`/unknown-code inputs (→ no toast). Reads optional data
  fields: `added`, `merged`, `count`, `ticker`, `list`, `name`, `isIOS`, `status`, `detail`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/toast-copy.test.mjs`:

```javascript
// Unit tests for describeOutcome — the single toast-copy map in app.js.
//   node backend/test/toast-copy.test.mjs
//
// app.js is a browser global script (no exports); slice out the self-contained
// describeOutcome fn and eval just that block in a vm sandbox (it has no external
// refs, so the sandbox is empty). Also anti-drift source guards for the hooks
// (added in Tasks 2-4).
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '..', '..', 'app.js'), 'utf8');

const start = src.indexOf('function describeOutcome(');
if (start < 0) { console.error('FAIL: describeOutcome not found in app.js'); process.exit(1); }
const endIdx = src.indexOf('\n}', start);
const block = src.slice(start, endIdx + 2);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(block + '\nglobalThis.describeOutcome = describeOutcome;', sandbox);
const { describeOutcome } = sandbox;

test('describeOutcome: null/garbage → null (no toast)', () => {
  assert.strictEqual(describeOutcome(undefined), null);
  assert.strictEqual(describeOutcome(null), null);
  assert.strictEqual(describeOutcome({}), null);
  assert.strictEqual(describeOutcome({ code: 'nope' }), null);
});

test('describeOutcome: C4 both branches', () => {
  assert.strictEqual(describeOutcome({ ok: true, code: 'position-added' }), 'Position added');
  assert.strictEqual(describeOutcome({ ok: true, code: 'shares-added' }), 'Shares added to existing position');
});

test('describeOutcome: dynamic import counts', () => {
  assert.strictEqual(describeOutcome({ code: 'positions-imported', added: 1, merged: 0 }), 'Imported 1 position');
  assert.strictEqual(describeOutcome({ code: 'positions-imported', added: 3, merged: 2 }), 'Imported 3 positions, merged 2');
  assert.strictEqual(describeOutcome({ code: 'contributions-imported', count: 1 }), 'Imported 1 entry');
  assert.strictEqual(describeOutcome({ code: 'contributions-imported', count: 4 }), 'Imported 4 entries');
});

test('describeOutcome: pluralised deletes', () => {
  assert.strictEqual(describeOutcome({ code: 'holdings-deleted', count: 1 }), 'Holding deleted');
  assert.strictEqual(describeOutcome({ code: 'holdings-deleted', count: 3 }), '3 holdings deleted');
  assert.strictEqual(describeOutcome({ code: 'deposits-removed', count: 1 }), 'Deposit removed');
  assert.strictEqual(describeOutcome({ code: 'deposits-removed', count: 2 }), '2 deposits removed');
});

test('describeOutcome: watchlist + data fields', () => {
  assert.strictEqual(describeOutcome({ code: 'watch-added', ticker: 'AAPL' }), 'Added AAPL');
  assert.strictEqual(describeOutcome({ code: 'watch-already', list: 'default' }), 'Already on watchlist');
  assert.strictEqual(describeOutcome({ code: 'watch-already', list: 'growth' }), 'Already on that list');
  assert.strictEqual(describeOutcome({ code: 'watchgroup-created', name: 'Growth' }), 'List "Growth" created');
});

test('describeOutcome: push variants', () => {
  assert.strictEqual(describeOutcome({ code: 'push-unsupported', isIOS: true }), 'On iPhone, install to Home Screen first');
  assert.strictEqual(describeOutcome({ code: 'push-unsupported', isIOS: false }), 'Push not supported in this browser');
  assert.strictEqual(describeOutcome({ code: 'push-connect-failed', detail: 'timeout' }), 'Could not connect: timeout');
  assert.strictEqual(describeOutcome({ code: 'push-test-failed', status: 500 }), 'Test failed (500)');
  assert.strictEqual(describeOutcome({ code: 'push-test-failed' }), 'Test failed (?)');
});

test('describeOutcome: every emitted code has copy (catalog guard)', () => {
  const codes = ['position-added','shares-added','positions-imported','sale-recorded','position-updated',
    'position-removed','holdings-deleted','contribution-logged','contribution-removed','contributions-imported',
    'deposit-missing-fields','deposit-logged','deposit-updated','deposit-removed','deposits-removed',
    'watch-added','watch-already','watch-removed','watch-removed-list','watch-added-list',
    'watchgroup-created','watchgroup-deleted','alert-set','preview-readonly','preview-load-failed',
    'push-no-url','push-not-https','push-unsupported','push-no-perm','push-connected','push-connect-failed',
    'push-test-sent','push-test-failed','push-test-error','push-disconnected','feed-unreachable','backup-saved'];
  for (const code of codes) {
    const s = describeOutcome({ code, added: 1, count: 1, ticker: 'X', list: 'default', name: 'N', status: 1, detail: 'e' });
    assert.ok(typeof s === 'string' && s.length > 0, `${code} must map to non-empty copy`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node backend/test/toast-copy.test.mjs`
Expected: FAIL — process exits with `FAIL: describeOutcome not found in app.js` (fn not added yet).

- [ ] **Step 3: Add `describeOutcome` to app.js**

Insert immediately above `const ToastContext = React.createContext(() => {});` (~L2679):

```javascript
// ─── Toast copy: the single place user-facing outcome messages live ───────────
// Data-layer mutators/actions return { ok, code, ...data } outcomes (no strings).
// The App edge maps each outcome to copy here and shows the toast. Returns null
// for outcomes that must not toast (no-ops, silent success, unknown codes).
function describeOutcome(o) {
  if (!o || typeof o.code !== 'string') return null;
  const d = o;
  switch (o.code) {
    // positions
    case 'position-added':         return 'Position added';
    case 'shares-added':           return 'Shares added to existing position';
    case 'positions-imported':     return `Imported ${d.added} position${d.added !== 1 ? 's' : ''}` + (d.merged ? `, merged ${d.merged}` : '');
    case 'sale-recorded':          return 'Sale recorded';
    case 'position-updated':       return 'Position updated';
    case 'position-removed':       return 'Position removed';
    case 'holdings-deleted':       return d.count === 1 ? 'Holding deleted' : `${d.count} holdings deleted`;
    // contributions
    case 'contribution-logged':    return 'Contribution logged';
    case 'contribution-removed':   return 'Contribution removed';
    case 'contributions-imported': return `Imported ${d.count} ${d.count === 1 ? 'entry' : 'entries'}`;
    // TFSA deposits
    case 'deposit-missing-fields': return 'Enter an amount and date';
    case 'deposit-logged':         return 'Deposit logged';
    case 'deposit-updated':        return 'Deposit updated';
    case 'deposit-removed':        return 'Deposit removed';
    case 'deposits-removed':       return d.count === 1 ? 'Deposit removed' : `${d.count} deposits removed`;
    // watchlist
    case 'watch-added':            return 'Added ' + d.ticker;
    case 'watch-already':          return 'Already on ' + (d.list === 'default' ? 'watchlist' : 'that list');
    case 'watch-removed':          return 'Removed ' + d.ticker;
    case 'watch-removed-list':     return 'Removed from list';
    case 'watch-added-list':       return 'Added to list';
    case 'watchgroup-created':     return `List "${d.name}" created`;
    case 'watchgroup-deleted':     return 'List deleted';
    // alerts
    case 'alert-set':              return 'Alert set';
    // preview
    case 'preview-readonly':       return 'Preview mode is on — turn it off in Settings to edit your real portfolio.';
    case 'preview-load-failed':    return 'Couldn’t load the demo portfolio — check your connection and toggle Preview again.';
    // push backend
    case 'push-no-url':            return 'Enter your push server URL';
    case 'push-not-https':         return 'Push server must be an https:// URL';
    case 'push-unsupported':       return d.isIOS ? 'On iPhone, install to Home Screen first' : 'Push not supported in this browser';
    case 'push-no-perm':           return 'Enable notifications first';
    case 'push-connected':         return 'Background push connected';
    case 'push-connect-failed':    return 'Could not connect: ' + (d.detail || 'error');
    case 'push-test-sent':         return 'Test push sent — check your lock screen';
    case 'push-test-failed':       return 'Test failed (' + (d.status || '?') + ')';
    case 'push-test-error':        return 'Test failed — is the server reachable?';
    case 'push-disconnected':      return 'Background push disconnected';
    // price feed (rationalized to one message)
    case 'feed-unreachable':       return 'Price feed unreachable — showing last known prices';
    // backup
    case 'backup-saved':           return 'Backup saved';
    default:                       return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node backend/test/toast-copy.test.mjs`
Expected: PASS — all `describeOutcome` tests green.

---

## Task 2: `usePortfolio` decoupled + `App` edge wiring

**Files:**
- Modify: `app.js`
  - `saveBackupFile`-unrelated; within `usePortfolio` (~L2194–2678): drop `toast` param;
    `guardPreview` returns an outcome; every mutator returns an outcome; C4 fix in `addPosition`;
    `previewLoadError` state + expose; demo-load `onerror` bumps it instead of toasting.
  - `App` (~L2922–2938): add `withToast`; call `usePortfolio(fxRates)`; wrap every preview-guarded
    export; add the `previewLoadError` effect.
  - `addWatchGroup` consumers at ~L7530 and ~L10240: read `.id` off the outcome.
- Test: `backend/test/toast-copy.test.mjs` (append anti-drift guards);
  `backend/test/verify-holdings-redesign.mjs` (browser smoke — existing)

**Interfaces:**
- Consumes: `describeOutcome` (Task 1); `PBStore.getCollection('positions')`.
- Produces: `withToast(fn) → wrapped fn`; `usePortfolio(fxRates)` (no `toast` param) returning the
  same shape **plus** `previewLoadError` (number), with every mutator now returning an outcome.

**Outcome contract for every `usePortfolio` mutator** (replace each `toast(X)` with `return <outcome>`):

| Mutator | Returns |
|---|---|
| `addPosition` (async) | `{ ok:true, code: existedBefore ? 'shares-added' : 'position-added' }` |
| `importPositions` (async) | `{ ok:true, code:'positions-imported', added, merged }` |
| `sellPosition` | `{ ok:true, code:'sale-recorded' }` |
| `updatePosition` | `{ ok:true, code:'position-updated' }` |
| `removePosition` | `{ ok:true, code:'position-removed' }` |
| `removePositions` | `{ ok:true, code:'holdings-deleted', count: set.size }` |
| `addContribution` | `{ ok:true, code:'contribution-logged' }` |
| `removeContribution` | `{ ok:true, code:'contribution-removed' }` |
| `importContributions` | `{ ok:true, code:'contributions-imported', count: mapped.length }` |
| `addTfsaDeposit` | success `{ ok:true, code:'deposit-logged' }`; guard `{ ok:false, code:'deposit-missing-fields' }` |
| `updateTfsaDeposit` | `{ ok:true, code:'deposit-updated' }` |
| `removeTfsaDeposit` | `{ ok:true, code:'deposit-removed' }` |
| `removeTfsaDeposits` | `{ ok:true, code:'deposits-removed', count: set.size }` |
| `addWatch` | already `{ ok:false, code:'watch-already', list }`; both add paths `{ ok:true, code:'watch-added', ticker }` |
| `toggleWatchList` | untracked → `return addWatch(...)`; removed-last `{ ok:true, code:'watch-removed', ticker }`; removed-one `{ ok:true, code:'watch-removed-list' }`; added `{ ok:true, code:'watch-added-list' }` |
| `addWatchGroup` | success `{ ok:true, code:'watchgroup-created', name: nm, id: g.id }`; empty name → `null` |
| `removeWatchGroup` | `{ ok:true, code:'watchgroup-deleted' }` (keep the `id==='default'` early `return;`) |
| `addAlert` | `{ ok:true, code:'alert-set' }` |
| `removeWatch`, `moveWatch`, `renameWatchGroup`, `removeAlert` | unchanged (no toast today; leave returns as-is) |

- [ ] **Step 1: Write the failing anti-drift test**

Append to `backend/test/toast-copy.test.mjs`:

```javascript
// ── anti-drift: usePortfolio decoupled from toast (Task 2) ────────────────────
function sliceFn(marker) {
  const s = src.indexOf(marker);
  if (s < 0) return null;
  const e = src.indexOf('\n}', s);
  return src.slice(s, e);
}

test('anti-drift: usePortfolio takes no toast param and calls no toast()', () => {
  assert.ok(/function usePortfolio\(fxRates\)\s*\{/.test(src), 'usePortfolio signature should be (fxRates)');
  const body = sliceFn('function usePortfolio(fxRates)');
  assert.ok(body && !/\btoast\(/.test(body), 'usePortfolio body must not call toast()');
});

test('anti-drift: App defines withToast and calls usePortfolio(fxRates)', () => {
  assert.ok(/const withToast = useCallback\(/.test(src), 'App should define withToast via useCallback');
  assert.ok(/usePortfolio\(fxRates\)/.test(src), 'App should call usePortfolio(fxRates) (no toast arg)');
  assert.ok(!/usePortfolio\(fxRates, toast\)/.test(src), 'the old usePortfolio(fxRates, toast) call must be gone');
});

test('anti-drift: addPosition reads live store for C4, not the stale closure', () => {
  const body = sliceFn('const addPosition = async');
  assert.ok(body && /PBStore\.getCollection\('positions'\)/.test(body),
    'addPosition should derive existed from the live store');
  assert.ok(body && !/toast\(positions\.find/.test(body), 'the C4 stale-closure toast must be gone');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node backend/test/toast-copy.test.mjs`
Expected: FAIL — the three new anti-drift tests fail (`usePortfolio(fxRates, toast)` still present, no `withToast`).

- [ ] **Step 3: Rewrite `guardPreview` to return an outcome + wire `previewLoadError`**

In `usePortfolio`, replace the demo-load `onerror` toast (~L2258-2261) and `guardPreview` (~L2272-2278):

```javascript
  const [previewLoadError, setPreviewLoadError] = useState(0);
```
Add that line near the other preview state (`const [, setDemoTick] = useState(0);`, ~L2245).

Change the `onerror` handler (~L2258):
```javascript
    el.onerror = () => {
      el.remove();
      setPreviewLoadError(n => n + 1);
    };
```

Change `guardPreview` (~L2272):
```javascript
  const guardPreview = (fn) => (...args) => {
    if (inPreview) return { ok: false, code: 'preview-readonly' };
    return fn(...args);
  };
```

- [ ] **Step 4: Drop the `toast` param and convert every mutator to return an outcome**

Change the signature (~L2194): `function usePortfolio(fxRates) {`.

Apply the Outcome-contract table above to every mutator. The non-trivial edits in full:

`addPosition` — replace the final `toast(...)` line (~L2358) with the C4-safe read + return. Add,
just before the existing `setPositions(prev => { ... })` call:
```javascript
    // C4 fix: read the live store, not the possibly-stale reactive `positions`
    // closure, so rapid successive adds report the correct message.
    const existedBefore = (PBStore.getCollection('positions') || [])
      .some(p => p.ticker === tickerUp && p.market === market);
```
and replace the trailing `toast(positions.find(...) ? ... : ...);` with:
```javascript
    return { ok: true, code: existedBefore ? 'shares-added' : 'position-added' };
```

`importPositions` — replace `toast(\`Imported ...\`);` (~L2422) with:
```javascript
    return { ok: true, code: 'positions-imported', added, merged };
```

`addTfsaDeposit` — replace the guard `if (!isFinite(amt) || amt === 0 || !date) { toast('Enter an amount and date'); return; }` (~L2523) with:
```javascript
    if (!isFinite(amt) || amt === 0 || !date) return { ok: false, code: 'deposit-missing-fields' };
```
and its success `toast('Deposit logged');` (~L2525) with `return { ok: true, code: 'deposit-logged' };`.

`addWatch` — replace the already-on guard (~L2556) and both success toasts (~L2559, ~L2575):
```javascript
      if (watchListIds(existing).includes(list)) return { ok: false, code: 'watch-already', list };
      setWatchlist(prev => prev.map(w => (w.ticker === ticker && w.market === market)
        ? { ...w, listIds: [...watchListIds(w), list], listId: undefined } : w));
      return { ok: true, code: 'watch-added', ticker };
```
and the new-entry path's trailing `toast('Added ' + ticker);` with `return { ok: true, code: 'watch-added', ticker };`.

`toggleWatchList` — the untracked branch (~L2587) must propagate `addWatch`'s outcome, and each
toast becomes a return:
```javascript
    if (!existing) return addWatch(ticker, market, name, list);
    const ids = watchListIds(existing);
    if (ids.includes(list)) {
      const next = ids.filter(x => x !== list);
      if (next.length === 0) {
        setWatchlist(prev => prev.filter(w => !(w.ticker === ticker && w.market === market)));
        return { ok: true, code: 'watch-removed', ticker };
      }
      setWatchlist(prev => prev.map(w => (w.ticker === ticker && w.market === market) ? { ...w, listIds: next, listId: undefined } : w));
      return { ok: true, code: 'watch-removed-list' };
    }
    setWatchlist(prev => prev.map(w => (w.ticker === ticker && w.market === market) ? { ...w, listIds: [...ids, list], listId: undefined } : w));
    return { ok: true, code: 'watch-added-list' };
```

`addWatchGroup` — keep returning the id, now inside an outcome (~L2603-2610):
```javascript
  const addWatchGroup = (name) => {
    const nm = (name || '').trim();
    if (!nm) return null;
    const g = { id: uid(), name: nm, createdAt: new Date().toISOString() };
    setWatchlistGroups(prev => [...prev, g]);
    return { ok: true, code: 'watchgroup-created', name: nm, id: g.id };
  };
```

`removeWatchGroup` — replace `toast('List deleted');` (~L2627) with `return { ok: true, code: 'watchgroup-deleted' };` (leave the `if (id === 'default') return;` guard).

`addAlert` — replace `toast('Alert set');` (~L2641) with `return { ok: true, code: 'alert-set' };`.

For the remaining simple mutators, replace the single trailing `toast(X)` per the table:
`sellPosition`→`sale-recorded`, `updatePosition`→`position-updated`, `removePosition`→`position-removed`,
`removePositions`→`{ code:'holdings-deleted', count: set.size }`, `addContribution`→`contribution-logged`,
`removeContribution`→`contribution-removed`, `importContributions`→`{ code:'contributions-imported', count: mapped.length }`,
`updateTfsaDeposit`→`deposit-updated`, `removeTfsaDeposit`→`deposit-removed`,
`removeTfsaDeposits`→`{ code:'deposits-removed', count: set.size }` (each `return { ok: true, code: ... }`).

Finally, add `previewLoadError` to the returned object (in the `return { ... }` block ~L2646):
add `previewLoadError,` alongside the read fields (e.g. after `sectorWeights, ...`).

- [ ] **Step 5: Wire the edge in `App`**

Replace the `const toast = useToast();` + big `usePortfolio(fxRates, toast)` destructure
(~L2922-2938) with:

```javascript
  const toast = useToast();
  // withToast: the edge. Run a data-layer action, map its { ok, code, ... } outcome
  // to copy (describeOutcome) and toast it. Promise-aware so async mutators toast
  // after they resolve; returns the action's own value/outcome unchanged so callers
  // that read a return (e.g. addWatchGroup's id) still work.
  const withToast = useCallback((fn) => (...args) => {
    const r = fn(...args);
    if (r && typeof r.then === 'function') {
      return r.then(o => { const m = describeOutcome(o); if (m) toast(m); return o; });
    }
    const m = describeOutcome(r); if (m) toast(m);
    return r;
  }, [toast]);
  const _p = usePortfolio(fxRates);
  // Reads + the two non-preview-guarded raw setters pass through untouched.
  const {
    positions, watchlist, watchlistGroups, alerts, contributions, transactions,
    tfsaDeposits, sectorCache, sectorWeights, previewLoadError,
    setAlerts, setSectorCache,
  } = _p;
  // Every preview-guarded export is wrapped so its outcome (success OR the
  // preview-readonly reject) toasts at the edge. Identities are recreated per
  // render, matching today's un-memoized mutators; identity-stabilization is the
  // next increment.
  const setPositions = withToast(_p.setPositions);
  const setWatchlist = withToast(_p.setWatchlist);
  const setWatchlistGroups = withToast(_p.setWatchlistGroups);
  const setContributions = withToast(_p.setContributions);
  const setTransactions = withToast(_p.setTransactions);
  const setTfsaDeposits = withToast(_p.setTfsaDeposits);
  const setSectorWeights = withToast(_p.setSectorWeights);
  const setSectorWeightsFor = withToast(_p.setSectorWeightsFor);
  const addPosition = withToast(_p.addPosition);
  const updatePosition = withToast(_p.updatePosition);
  const removePosition = withToast(_p.removePosition);
  const removePositions = withToast(_p.removePositions);
  const sellPosition = withToast(_p.sellPosition);
  const importPositions = withToast(_p.importPositions);
  const addContribution = withToast(_p.addContribution);
  const removeContribution = withToast(_p.removeContribution);
  const importContributions = withToast(_p.importContributions);
  const addTfsaDeposit = withToast(_p.addTfsaDeposit);
  const updateTfsaDeposit = withToast(_p.updateTfsaDeposit);
  const removeTfsaDeposit = withToast(_p.removeTfsaDeposit);
  const removeTfsaDeposits = withToast(_p.removeTfsaDeposits);
  const addWatch = withToast(_p.addWatch);
  const removeWatch = withToast(_p.removeWatch);
  const moveWatch = withToast(_p.moveWatch);
  const toggleWatchList = withToast(_p.toggleWatchList);
  const addWatchGroup = withToast(_p.addWatchGroup);
  const renameWatchGroup = withToast(_p.renameWatchGroup);
  const removeWatchGroup = withToast(_p.removeWatchGroup);
  const addAlert = withToast(_p.addAlert);
  const removeAlert = withToast(_p.removeAlert);
  useEffect(() => {
    if (previewLoadError > 0) { const m = describeOutcome({ code: 'preview-load-failed' }); if (m) toast(m); }
  }, [previewLoadError]);
```

- [ ] **Step 6: Update `addWatchGroup` consumers to read `.id` off the outcome**

At ~L7530: `const id = onAddWatchGroup && onAddWatchGroup(newListName);` →
```javascript
    const _r = onAddWatchGroup && onAddWatchGroup(newListName);
    const id = _r && _r.id;
```
At ~L10240: `const id = onAddWatchGroup(nm);` →
```javascript
    const _r = onAddWatchGroup(nm);
    const id = _r && _r.id;
```

- [ ] **Step 7: Run the anti-drift test to verify it passes**

Run: `node backend/test/toast-copy.test.mjs`
Expected: PASS — all `describeOutcome` + the three Task-2 anti-drift tests green.

- [ ] **Step 8: Browser smoke — toast still fires after add-position**

Run: `node backend/test/verify-holdings-redesign.mjs`
Expected: PASS — app mounts and holdings render (US/JSE/TFSA avg-cost values). If the run hits the
known flaky CDP "Execution context destroyed" race, re-run once; the assertion-based checks are the
gate.

---

## Task 3: `usePushBackend` decoupled + `App` wiring

**Files:**
- Modify: `app.js` — `usePushBackend` (~L2105-2183): drop `toast` param + deps; `connectPush`/
  `testPush`/`disconnectPush` return outcomes. `App` push destructure (~L3173-3174): drop the
  `toast` arg and wrap the three fns with `withToast`.
- Test: `backend/test/toast-copy.test.mjs` (append anti-drift guard)

**Interfaces:**
- Consumes: `withToast` (Task 2), `describeOutcome` (Task 1).
- Produces: `usePushBackend(pushBackend, setPushBackend, alerts, notifPerm)` returning
  `{ pushStatus, connectPush, testPush, disconnectPush }` where the three actions return outcomes.

- [ ] **Step 1: Write the failing anti-drift test**

Append to `backend/test/toast-copy.test.mjs`:

```javascript
// ── anti-drift: usePushBackend decoupled (Task 3) ─────────────────────────────
test('anti-drift: usePushBackend takes no toast param and calls no toast()', () => {
  assert.ok(/function usePushBackend\(pushBackend, setPushBackend, alerts, notifPerm\)\s*\{/.test(src),
    'usePushBackend signature should drop the toast param');
  const body = sliceFn('function usePushBackend(');
  assert.ok(body && !/\btoast\(/.test(body), 'usePushBackend body must not call toast()');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node backend/test/toast-copy.test.mjs`
Expected: FAIL — the new test fails (signature still has `, toast)`).

- [ ] **Step 3: Convert the push actions to outcomes**

Change the signature (~L2105): `function usePushBackend(pushBackend, setPushBackend, alerts, notifPerm) {`.

Replace `connectPush` (~L2141-2163):
```javascript
  const connectPush = useCallback(async (url) => {
    const b = normalizeBackend(url);
    if (!b) return { ok: false, code: 'push-no-url' };
    if (!/^https:\/\//i.test(b)) return { ok: false, code: 'push-not-https' };
    if (!pushSupported()) {
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
      return { ok: false, code: 'push-unsupported', isIOS };
    }
    if (notifPerm !== 'granted') return { ok: false, code: 'push-no-perm' };
    setPushStatus('connecting');
    try {
      await registerPushWithBackend(b, alertsRef.current);
      setPushBackend(b);
      setPushStatus('connected');
      return { ok: true, code: 'push-connected' };
    } catch (e) {
      setPushStatus('error');
      return { ok: false, code: 'push-connect-failed', detail: e.message || 'error' };
    }
  }, [notifPerm, setPushBackend]);
```

Replace `testPush` (~L2164-2170):
```javascript
  const testPush = useCallback(async () => {
    if (!base) return null;
    try {
      const r = await backendPost(base, '/test', { clientId: pushClientId() });
      return r.ok ? { ok: true, code: 'push-test-sent' } : { ok: false, code: 'push-test-failed', status: r.status };
    } catch (_e) { return { ok: false, code: 'push-test-error' }; }
  }, [base]);
```

Replace the tail of `disconnectPush` (~L2178-2181) — swap `toast('Background push disconnected');`
for a return:
```javascript
    setPushBackend('');
    setPushStatus('off');
    return { ok: true, code: 'push-disconnected' };
  }, [base, setPushBackend]);
```

- [ ] **Step 4: Wire the edge in `App`**

Replace the push destructure (~L3173-3174):
```javascript
  const { pushStatus, connectPush: _connectPush, testPush: _testPush, disconnectPush: _disconnectPush } =
    usePushBackend(pushBackend, setPushBackend, alerts, notifPerm);
  const connectPush = withToast(_connectPush);
  const testPush = withToast(_testPush);
  const disconnectPush = withToast(_disconnectPush);
```

- [ ] **Step 5: Run to verify it passes**

Run: `node backend/test/toast-copy.test.mjs`
Expected: PASS — Task-3 anti-drift test green.

- [ ] **Step 6: Browser smoke — settings**

Run: `node backend/test/verify-settings.mjs`
Expected: PASS — settings checks green (re-run once if the flaky CDP race hits).

---

## Task 4: `usePriceFeed` + `saveBackupFile` decoupled

**Files:**
- Modify: `app.js` — `usePriceFeed` (~L1751-1856): drop `toast` param + the two status toasts +
  `toast` dep; `saveBackupFile` (~L162-182): drop `toast` param, return an outcome; the backup
  caller (~L3271) wraps with `withToast`; `App` adds a `failStreak` effect for the one feed toast.
- Test: `backend/test/toast-copy.test.mjs` (append anti-drift guards);
  `backend/test/verify-refresh-behavior.mjs` (browser smoke — existing)

**Interfaces:**
- Consumes: `withToast`, `describeOutcome`, the `failStreak` already returned by `usePriceFeed`.
- Produces: `usePriceFeed(order, fetchKey)` (no `toast`); `saveBackupFile(jsonString) → Promise<{ok,code}>`.

- [ ] **Step 1: Write the failing anti-drift test**

Append to `backend/test/toast-copy.test.mjs`:

```javascript
// ── anti-drift: usePriceFeed + saveBackupFile decoupled (Task 4) ──────────────
test('anti-drift: usePriceFeed takes no toast param and calls no toast()', () => {
  assert.ok(/function usePriceFeed\(order, fetchKey\)\s*\{/.test(src),
    'usePriceFeed signature should be (order, fetchKey)');
  const body = sliceFn('function usePriceFeed(');
  assert.ok(body && !/\btoast\(/.test(body), 'usePriceFeed body must not call toast()');
});

test('anti-drift: saveBackupFile takes no toast param and calls no toast()', () => {
  assert.ok(/async function saveBackupFile\(jsonString\)\s*\{/.test(src),
    'saveBackupFile signature should be (jsonString)');
  const body = sliceFn('async function saveBackupFile(');
  assert.ok(body && !/\btoast\(/.test(body), 'saveBackupFile body must not call toast()');
});

test('anti-drift: App toasts the one feed-unreachable message off failStreak', () => {
  assert.ok(/failStreak === 2/.test(src), 'App should key the feed toast off failStreak === 2');
  assert.ok(!/toast\('Price refresh failed'\)/.test(src), "the separate 'Price refresh failed' toast must be gone");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node backend/test/toast-copy.test.mjs`
Expected: FAIL — the three new tests fail.

- [ ] **Step 3: Decouple `usePriceFeed`**

Change the signature (~L1751): `function usePriceFeed(order, fetchKey) {`.

In the `failStreak` bump (~L1810-1816), drop the toast — keep the increment:
```javascript
        } else if (orderRef.current.length > 0) {
          setFailStreak(prev => prev + 1);
        }
```

In the `catch` (~L1818-1822), drop the toast — keep the bump:
```javascript
    } catch (e) {
      console.error('Refresh failed:', e);
      setFailStreak(prev => prev + 1);
    }
```

Update the `runFetch` `useCallback` deps (~L1825) from `[toast, persistPrices]` to `[persistPrices]`.

- [ ] **Step 4: Decouple `saveBackupFile`**

Change the signature (~L162): `async function saveBackupFile(jsonString) {`. Replace the trailing
`if (toast) toast('Backup saved');` (~L181) with:
```javascript
  return { ok: true, code: 'backup-saved' };
```

- [ ] **Step 5: Wire the edge in `App` (feed effect + backup caller)**

At the backup caller (~L3271), wrap with `withToast`:
```javascript
    withToast(saveBackupFile)(JSON.stringify(gatherBackup(), null, 2));
```

Add a feed-status effect near the `usePriceFeed` call in `App` (after `failStreak` is in scope,
~L3038):
```javascript
  useEffect(() => {
    if (failStreak === 2) { const m = describeOutcome({ code: 'feed-unreachable' }); if (m) toast(m); }
  }, [failStreak]);
```

Update the `usePriceFeed` call (~L3038) to drop the `toast` arg:
```javascript
  const { loading, lastUpdate, failStreak, refreshNow: refreshPricesNow, mergePrices } = usePriceFeed(fetchOrder, fetchKey);
```

- [ ] **Step 6: Run to verify it passes**

Run: `node backend/test/toast-copy.test.mjs`
Expected: PASS — all Task-4 anti-drift tests green.

- [ ] **Step 7: Browser smoke — refresh behavior**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: PASS — app mounts, "Today" P/L pill renders; no `toast`-related ReferenceError (re-run
once if the flaky CDP race hits).

---

## Task 5: Cache bump + full verification + handoff

**Files:**
- Modify: `sw.js:2` (`CACHE_NAME`)

**Interfaces:**
- Consumes: all prior tasks complete.

- [ ] **Step 1: Bump the service-worker cache version**

In `sw.js` line 2, change `const CACHE_NAME   = 'playbook-shell-v42';` to
`const CACHE_NAME   = 'playbook-shell-v43';`.

- [ ] **Step 2: Syntax-check the changed scripts**

Run: `node --check app.js && node --check sw.js`
Expected: no output, exit 0.

- [ ] **Step 3: Run the full node test suite**

Run: `for f in backend/test/*.test.mjs; do echo "== $f =="; node "$f" || exit 1; done`
Expected: every suite green, including the new `toast-copy.test.mjs`. The "money gate"
(`money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse`) must pass unchanged — no formula
was touched.

- [ ] **Step 4: Run the reliable browser smokes**

Run: `node backend/test/verify-refresh-behavior.mjs && node backend/test/verify-holdings-redesign.mjs && node backend/test/verify-settings.mjs`
Expected: all PASS (re-run any that hit the known flaky CDP "Execution context destroyed" race —
it is environmental, not from this change).

- [ ] **Step 5: Hand off to Jan**

Do **not** commit or merge. Summarize for Jan: files changed (`app.js`, `sw.js`, new
`backend/test/toast-copy.test.mjs`), the one behavior change (price-feed toast rationalized), test
results, and that `describeOutcome` now owns all data-layer copy. Jan reviews, commits, and merges.

---

## Self-review notes

- **Spec coverage:** outcome contract (Task 1–2), edge/`withToast` + `describeOutcome` (Task 1–2),
  `usePushBackend` (Task 3), `usePriceFeed` rationalized + `saveBackupFile` (Task 4), C4 fix
  (Task 2, via live store), rationalized copy (Task 1 map), anti-drift guards + browser smokes
  (each task), sw bump / no-new-file / no-worker-impact (Global + Task 5). The ~12 already-at-edge
  toasts are intentionally untouched (out of scope).
- **Type consistency:** every `code` string emitted by a mutator (Task 2–4 tables/edits) appears in
  the `describeOutcome` switch (Task 1) and in the Task-1 catalog-guard test.
- **Known non-goal:** wrapper/mutator identity stabilization + `React.memo` sweep is the *next*
  Phase 3 increment; `withToast` wrappers are intentionally recreated per render here.
