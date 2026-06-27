# Phase 2 Increment 3 — Fetch Fan-out Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop polling the entire static recommendation universe every 45s — poll only the user's own holdings/watchlist/alerts/ribbon on the routine cadence, and fetch the Picks/Hedges/Thesis lists lazily (only once their tab is visited), with the active tab floated to the front of the fetch order.

**Architecture:** A new pure helper `buildFetchPlan` in `pb-core.js` computes both the ordered fetch list (`order`, active lazy tab floated front) and a fast-tier-only membership signature (`key`). `app.js`'s `usePriceFeed`/`tickersToFetch`/`usePolledRefresh` are rewired to consume `{order, key}`: `order` drives the batch fetch + paint priority, `key` drives the auto-refetch-on-change so reorders/warming never re-fetch. A `warmedLists` Set + a `view` effect warm lazy lists on first visit and force an immediate prioritized refresh. Bulk `DATA.HOLDINGS` and `US:VOO` polling is dropped.

**Tech Stack:** Vanilla ES (no build step, no JSX), React 18 UMD, dual-mode `pb-core.js` (`globalThis.PBCore` + CommonJS), Node `.mjs` test files run individually with `node X.test.mjs`, a headless-Chrome smoke harness (`backend/test/verify-refresh-behavior.mjs`), `sw.js` precache, GitHub Pages allowlist deploy.

## Global Constraints

- **No build step.** Plain classic scripts loaded in order. The only files touched are `pb-core.js`, `app.js`, `sw.js`, and two `backend/test/*.mjs` files. No new `<script>` file ⇒ no `index.html`/`static.yml` change.
- **`pb-core.js` = pure, side-effect-free, worker-shared.** The kernel takes all inputs as arguments; no React/DOM/network.
- **Bind pattern in `app.js`:** never reintroduce a moved/added pure fn as a local `function`; bind with `const buildFetchPlan = PBCore.buildFetchPlan;`.
- **Dual-mode footer already present in `pb-core.js`** — just add `buildFetchPlan` to the existing `const PBCore = { ... }` object.
- **TDD, RED first.** Write the failing test, watch it fail for the right reason, then implement. Commit after each green task.
- **Test runner:** no npm script. Run `cd backend/test && node <file>.test.mjs`. House helper `ok(name, cond)` + `process.exit(failures ? 1 : 0)`. Import with `import PBCore from '../../pb-core.js'`.
- **Anti-drift guard:** the extraction test reads `app.js` source and asserts it binds `buildFetchPlan` from `PBCore` and carries no local `function buildFetchPlan(`.
- **Line endings:** `app.js`/`pb-core.js` are CRLF; the Edit tool normalizes CRLF on match, so `\n` old-strings match. New test files are written with `\n`.
- **Price-map key:** `priceKey(market, ticker) => 'market:ticker'` is already in `pb-core.js` (line 65) and bound in `app.js`. `buildFetchPlan` reuses it internally; `app.js` builds tier inputs with the bound `priceKey`.
- **No worker/SW logic change, no `wrangler deploy`.** Only a `sw.js` cache-version bump so the changed `app.js`/`pb-core.js` are re-fetched.

---

## Task 1: Add the pure `buildFetchPlan` kernel to `pb-core.js`

The set-union + float-to-front ordering + fast-tier membership key is the only genuinely pure, reusable logic. It lives in `pb-core.js` and is unit-tested in isolation.

**Files:**
- Modify: `pb-core.js` (add `buildFetchPlan` after `priceKey` at line 65; add `buildFetchPlan,` to the `const PBCore = {` object at lines 467-476)
- Test: `backend/test/fetch-plan.test.mjs` (new)

**Interfaces:**
- Produces: `PBCore.buildFetchPlan({ fastTiers, lazyLists, warmed, activeView }) => { order, key }`
  - `fastTiers`: `Array<Array<string>>` — tiers of `priceKey` strings in priority order, e.g. `[positionsKeys, watchlistKeys, alertsKeys, ribbonKeys]`.
  - `lazyLists`: `Record<viewKey, Array<string>>` — each lazy view's `priceKey` strings.
  - `warmed`: `Set<string> | Array<string>` — lazy view keys already visited.
  - `activeView`: `string` — the current view key.
  - Returns `order`: `Array<{market, ticker}>` — active lazy list first (if `activeView` is lazy), then fast tiers in order, then remaining warmed lazy lists; deduped by key, first occurrence wins.
  - Returns `key`: `string` — the fast-tier price-keys only, deduped, **sorted**, joined with `,`. Independent of order and of which lazy lists are warmed/active.

- [ ] **Step 1: Write the failing test** — create `backend/test/fetch-plan.test.mjs`:

```js
// Unit tests for the pure buildFetchPlan kernel in pb-core.js (Phase 2 inc 3).
//   cd backend/test && node fetch-plan.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const keys = (order) => order.map(o => o.market + ':' + o.ticker);

const fast = [['US:AAPL', 'US:GOOGL'], ['JSE:NPN'], [], ['US:^SPX']]; // positions, watchlist, alerts, ribbon
const lazy = { picks: ['US:NVDA', 'US:AMD'], hedges: ['US:GLD'], overview: ['US:C'] };

ok('PBCore exports buildFetchPlan', typeof PBCore.buildFetchPlan === 'function');

// No active lazy view, nothing warmed → fast tiers only, in tier order, deduped.
let p = PBCore.buildFetchPlan({ fastTiers: fast, lazyLists: lazy, warmed: new Set(), activeView: 'dashboard' });
ok('cold: order is fast tiers in order', keys(p.order).join(',') === 'US:AAPL,US:GOOGL,JSE:NPN,US:^SPX');
ok('cold: no lazy symbols present', !keys(p.order).some(k => ['US:NVDA','US:AMD','US:GLD','US:C'].includes(k)));

// Active = picks → picks float to the FRONT, then fast tiers.
p = PBCore.buildFetchPlan({ fastTiers: fast, lazyLists: lazy, warmed: new Set(['picks']), activeView: 'picks' });
ok('active picks floats to front', keys(p.order).slice(0, 2).join(',') === 'US:NVDA,US:AMD');
ok('fast tiers follow the floated list', keys(p.order).join(',') === 'US:NVDA,US:AMD,US:AAPL,US:GOOGL,JSE:NPN,US:^SPX');

// Warmed-but-inactive list is included AFTER the fast tiers (active=picks, hedges warmed).
p = PBCore.buildFetchPlan({ fastTiers: fast, lazyLists: lazy, warmed: new Set(['picks', 'hedges']), activeView: 'picks' });
ok('warmed inactive list trails the fast tiers', keys(p.order).join(',') === 'US:NVDA,US:AMD,US:AAPL,US:GOOGL,JSE:NPN,US:^SPX,US:GLD');

// Dedupe: a ticker in both the active lazy list and the fast tier appears once, in the floated slot.
let p2 = PBCore.buildFetchPlan({ fastTiers: [['US:NVDA', 'US:AAPL']], lazyLists: lazy, warmed: new Set(['picks']), activeView: 'picks' });
ok('dedupe keeps first occurrence (floated)', keys(p2.order).join(',') === 'US:NVDA,US:AMD,US:AAPL');

// key = fast-tier membership only, sorted, joined.
ok('key is fast-tier price-keys sorted', p.key === ['US:AAPL','US:GOOGL','JSE:NPN','US:^SPX'].sort().join(','));

// ANTI-THRASH INVARIANT: key is identical under reorder (different activeView) and
// under lazy-list warming, but differs when fast-tier membership changes.
const kPicks = PBCore.buildFetchPlan({ fastTiers: fast, lazyLists: lazy, warmed: new Set(['picks']), activeView: 'picks' }).key;
const kHedges = PBCore.buildFetchPlan({ fastTiers: fast, lazyLists: lazy, warmed: new Set(['picks','hedges']), activeView: 'hedges' }).key;
ok('key stable under reorder + warming', kPicks === kHedges);
const kMore = PBCore.buildFetchPlan({ fastTiers: [['US:AAPL','US:GOOGL','US:TSLA'], ['JSE:NPN'], [], ['US:^SPX']], lazyLists: lazy, warmed: new Set(), activeView: 'dashboard' }).key;
ok('key changes when fast-tier membership changes', kMore !== kPicks);

// Tolerates array warmed + missing/empty inputs.
let p3 = PBCore.buildFetchPlan({ fastTiers: [['US:AAPL']], lazyLists: {}, warmed: ['picks'], activeView: 'dashboard' });
ok('array warmed + empty lazyLists is safe', keys(p3.order).join(',') === 'US:AAPL' && p3.key === 'US:AAPL');

// Anti-drift guard.
ok('app.js binds buildFetchPlan from PBCore', /const\s+buildFetchPlan\s*=\s*PBCore\.buildFetchPlan/.test(appSrc));
ok('app.js has no local function buildFetchPlan', !/function\s+buildFetchPlan\s*\(/.test(appSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll fetch-plan tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend/test && node fetch-plan.test.mjs`
Expected: FAIL — `PBCore exports buildFetchPlan` is false (and the `app.js` bind/guard rows fail).

- [ ] **Step 3: Implement `buildFetchPlan` in `pb-core.js`** — insert immediately after the `priceKey` function (after line 65, before the `// ─── Price-alert evaluation ───` comment):

```js

  // Two-tier price-fetch planner (Phase 2 inc 3). Given the user's own tiers (in
  // priority order), the lazy per-view lists, the set of already-visited (warmed)
  // lazy views, and the active view, returns:
  //   order — the de-duped fetch list as {market,ticker}, with the ACTIVE lazy
  //           list floated to the front so what's on screen refreshes first,
  //           then the fast tiers, then any other warmed lazy lists.
  //   key   — the FAST-TIER membership signature (sorted, joined). It excludes the
  //           lazy lists on purpose, so reordering (a tab switch) or warming a new
  //           lazy list never changes it — only a change to the user's own universe
  //           does. Callers use it as the "refetch when this changes" key.
  function buildFetchPlan({ fastTiers = [], lazyLists = {}, warmed, activeView } = {}) {
    const warmedSet = warmed instanceof Set ? warmed : new Set(warmed || []);
    const seen = new Set();
    const orderedKeys = [];
    const push = (k) => { if (k && !seen.has(k)) { seen.add(k); orderedKeys.push(k); } };
    // 1. Active lazy list first (only if the active view actually is a lazy list).
    if (activeView && lazyLists[activeView]) lazyLists[activeView].forEach(push);
    // 2. Fast tiers in their given priority order.
    fastTiers.forEach(tier => (tier || []).forEach(push));
    // 3. Remaining warmed lazy lists (the active one is already in).
    warmedSet.forEach(v => { if (v !== activeView && lazyLists[v]) lazyLists[v].forEach(push); });
    // key: fast-tier price-keys only, de-duped + sorted so it is order-independent.
    const fastSeen = new Set();
    fastTiers.forEach(tier => (tier || []).forEach(k => { if (k) fastSeen.add(k); }));
    const key = Array.from(fastSeen).sort().join(',');
    const order = orderedKeys.map(k => { const i = k.indexOf(':'); return { market: k.slice(0, i), ticker: k.slice(i + 1) }; });
    return { order, key };
  }
```

- [ ] **Step 4: Add `buildFetchPlan` to the `PBCore` export object** — in the `const PBCore = {` block, add it next to `priceKey` (after line 472 `priceKey,`):

```js
    priceKey,
    buildFetchPlan,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend/test && node fetch-plan.test.mjs`
Expected: PASS — `All fetch-plan tests passed`. (The two anti-drift rows still FAIL here — `app.js` isn't wired yet. That's expected; they go green in Task 3. If you want a fully-green Task 1, temporarily skip the two anti-drift rows and re-enable in Task 3 — but simplest is to accept those two reds until Task 3 and verify only the logic rows pass now.)

> NOTE: To keep Task 1 self-contained and fully green, the two anti-drift rows are the ONLY ones that depend on `app.js`. Confirm every other row passes now; they will all pass together after Task 3.

- [ ] **Step 6: Sanity-check the module parses**

Run: `node --check pb-core.js`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add pb-core.js backend/test/fetch-plan.test.mjs
git commit -m "Add pure buildFetchPlan kernel to pb-core.js (Phase 2 inc 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Extend the browser smoke harness (RED — pins the end-to-end behavior)

`buildFetchPlan` is unit-tested, but the actual fan-out reduction is a React/runtime behavior the node suites can't see (they never load `app.js` in a browser). Add the failing browser assertions first.

**Files:**
- Modify: `backend/test/verify-refresh-behavior.mjs` (add a cold-start exclusion assertion after the auto-poll snapshot ~line 136; add a lazy-tab-activation block before `ws.close()` ~line 162)

**Interfaces:**
- Consumes: the running app served by the harness, the page globals `DATA` (from `data.js`) and `window.__log` (the harness's fetch log), and nav buttons selectable by `button[data-tab="<key>"]`.

- [ ] **Step 1: Add the cold-start exclusion assertion.** In `backend/test/verify-refresh-behavior.mjs`, immediately after the existing line `ok('auto-poll does NOT cache-bust', autoLog.length > 0 && autoLog.every(e => e.cb === false));` (~line 136), insert:

```js

  // Phase 2 inc 3: the routine cold-start poll must NOT include the static
  // recommendation lists (DATA.NEW_PICKS / DATA.HEDGES) or the dead VOO benchmark
  // — they are now lazy/on-view. This is the regression that proves fan-out dropped.
  const lazySyms = JSON.parse(await evals(ws, `return JSON.stringify([...DATA.NEW_PICKS, ...DATA.HEDGES].map(x => x.ticker).concat('VOO'));`));
  const polledLazy = [...new Set(autoLog.filter(e => lazySyms.includes(e.sym)).map(e => e.sym))];
  ok('cold start excludes static lists (picks/hedges/VOO)', polledLazy.length === 0, polledLazy.join(',') || 'none');
```

- [ ] **Step 2: Add the lazy-tab-activation block.** Immediately before `ws.close();` (~line 162), insert:

```js

  // ---- LAZY TAB ACTIVATION: opening Picks warms its list AND floats it to front ----
  await evals(ws, `window.__log = []; return true;`);
  const wentPicks = await evals(ws, `const b=document.querySelector('button[data-tab="picks"]'); if(!b) return false; b.click(); return true;`);
  ok('picks tab nav button exists & clickable', wentPicks === true);
  await sleep(2500);
  const picksLog = JSON.parse(await evals(ws, `return JSON.stringify(window.__log);`));
  const picksSyms = JSON.parse(await evals(ws, `return JSON.stringify(DATA.NEW_PICKS.map(p => p.ticker));`));
  const firstPickIdx = picksLog.findIndex(e => picksSyms.includes(e.sym));
  ok('opening Picks fetches its list (lazy warm)', firstPickIdx >= 0);
  const firstPosIdx2 = Math.min(...['AAPL', 'GOOGL'].map(s => { const i = picksLog.findIndex(e => e.sym === s); return i < 0 ? Infinity : i; }));
  ok('active Picks list floats to the front of the sweep', firstPickIdx >= 0 && firstPickIdx < firstPosIdx2, `pick=${firstPickIdx} pos=${firstPosIdx2}`);
```

- [ ] **Step 3: Run the harness to verify the NEW assertions fail (RED)**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: the run reaches the end but reports failures: `cold start excludes static lists` FAILS (current code polls all 36, so picks/hedges/VOO are present), and `active Picks list floats to the front` FAILS (current code has no view-change refresh + picks are last). The pre-existing assertions still pass.

> If Chrome isn't at `C:\Program Files\Google\Chrome\Application\chrome.exe`, update the `CHROME` constant at the top of the harness first.

- [ ] **Step 4: Commit the RED test**

```bash
git add backend/test/verify-refresh-behavior.mjs
git commit -m "Add failing browser smokes for fan-out split + lazy-tab float (Phase 2 inc 3, RED)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire the two-tier plan into `app.js` + bump the SW cache (GREEN)

Rework the universe/feed to consume `{order, key}`, add the lazy-list config + warm-set + view effect, drop the dead polling, and route `OverviewView` through the shared snapshot const.

**Files:**
- Modify: `pb-core.js` — none (done in Task 1).
- Modify: `app.js` — add `THESIS_SNAPSHOT`+`LAZY_LISTS` (after line 2628); bind `buildFetchPlan` (next to the other `PBCore.x` binds); add `warmedLists` state (near `view`, line 2717); rework the `tickersToFetch` memo (2874-2895); update the `usePriceFeed` call (2896); update the splash-gate refs (2927, 2934); add the view effect (after 2896); rework `usePriceFeed` internals (1735-1834); route `OverviewView` (9253).
- Modify: `sw.js:2` — cache version v33 → v34.

**Interfaces:**
- Consumes: `PBCore.buildFetchPlan` (Task 1), the bound `priceKey`, the static `DATA.NEW_PICKS`/`DATA.HEDGES`, and the existing `usePolledRefresh`/`fetchQuoteBatch`/`anyMarketOpen`.
- Produces: `usePriceFeed(order, fetchKey, toast)` — the hook now takes the ordered list, the fast-tier membership key, and toast (was `(tickersToFetch, toast)`).

- [ ] **Step 1: Add `THESIS_SNAPSHOT` + `LAZY_LISTS`** — in `app.js`, after the line `const TAB_ALWAYS_VISIBLE = 'dashboard';` (line 2628), insert:

```js
// Static recommendation lists are fetched lazily — only once their tab has been
// visited (Phase 2 inc 3) — instead of on every 45s poll. THESIS_SNAPSHOT is the
// handful of names the Thesis (overview) tab shows live; shared with OverviewView
// so the snapshot and the poll list can't drift. DATA is a data.js global,
// available at module-eval time (data.js loads before app.js).
const THESIS_SNAPSHOT = ['NVDA', 'GOOGL', 'C', 'ASML'];
const LAZY_LISTS = {
  picks:    DATA.NEW_PICKS.map(p => 'US:' + p.ticker),
  hedges:   DATA.HEDGES.map(h => 'US:' + h.ticker),
  overview: THESIS_SNAPSHOT.map(t => 'US:' + t),
};
```

- [ ] **Step 2: Bind `buildFetchPlan`** — find the existing `priceKey` bind in `app.js` (`const priceKey = PBCore.priceKey;`) and add directly below it:

```js
const buildFetchPlan = PBCore.buildFetchPlan;
```

- [ ] **Step 3: Add the `warmedLists` state** — in the `App` component, immediately after `const [view, setView] = useState('dashboard');` (line 2717), insert:

```js
  // Lazy price lists (picks/hedges/thesis) the user has visited this session.
  // Once a tab is opened its list stays in the poll set until reload (kept warm).
  const [warmedLists, setWarmedLists] = useState(() => new Set());
```

- [ ] **Step 4: Rework the `tickersToFetch` memo.** Replace the whole memo block (lines 2874-2895, from `const tickersToFetch = useMemo(() => {` through `}, [positions, watchlist, alerts, ribbonItems]);`) with:

```js
  // Two-tier fetch plan (Phase 2 inc 3). Fast tier = the user's own universe,
  // always polled, positions first (they drive the portfolio "today" move). The
  // static recommendation lists are appended only once their tab is warmed, and
  // the ACTIVE lazy tab floats to the front so what's on screen refreshes first.
  // `order` drives the batch fetch + paint order; `fetchKey` (fast-tier membership
  // only) drives the auto-refetch-on-change so a mere tab switch never re-sweeps.
  const { order: fetchOrder, key: fetchKey } = useMemo(() => buildFetchPlan({
    fastTiers: [
      positions.map(p => priceKey(p.market, p.ticker)),
      watchlist.map(w => priceKey(w.market, w.ticker)),
      alerts.map(a => priceKey(a.market, a.ticker)),
      ribbonItems,
    ],
    lazyLists: LAZY_LISTS,
    warmed: warmedLists,
    activeView: view,
  }), [positions, watchlist, alerts, ribbonItems, warmedLists, view]);
```

- [ ] **Step 5: Update the `usePriceFeed` call.** Replace line 2896:

```js
  const { prices, loading, lastUpdate, failStreak, refreshNow: refreshPricesNow, mergePrices } = usePriceFeed(tickersToFetch, toast);
```

with:

```js
  const { prices, loading, lastUpdate, failStreak, refreshNow: refreshPricesNow, mergePrices } = usePriceFeed(fetchOrder, fetchKey, toast);
```

- [ ] **Step 6: Add the view effect** (warm-on-visit + immediate prioritized refresh) immediately AFTER the `usePriceFeed` call from Step 5:

```js
  // Entering a lazy tab: warm its list on first visit (so it joins the poll set)
  // and force an immediate, prioritized refresh so its prices are fresh within a
  // tick (the rehydrated cache paints last-known meanwhile). refreshPricesNow never
  // restarts an in-flight sweep — it lets the current one finish then runs once
  // more, and the float-to-front order is picked up via the feed's order ref. Deps
  // are [view] only: warmedLists/refreshPricesNow are read but we react solely to
  // tab changes (refreshPricesNow is stable; warmedLists only changes via this effect).
  useEffect(() => {
    if (!LAZY_LISTS[view]) return;
    if (!warmedLists.has(view)) setWarmedLists(prev => { const next = new Set(prev); next.add(view); return next; });
    refreshPricesNow();
  }, [view]);
```

- [ ] **Step 7: Update the splash-gate references.** At line 2927 replace `tickersToFetch.length === 0` with `fetchOrder.length === 0`:

```js
    const ready = warmStart || lastUpdate || positionsCached || failStreak >= 2 || fetchOrder.length === 0;
```

and at line 2934 replace the dep `tickersToFetch.length` with `fetchOrder.length`:

```js
  }, [booting, warmStart, lastUpdate, positionsCached, failStreak, fetchOrder.length]);
```

- [ ] **Step 8: Rework the `usePriceFeed` signature + order ref.** Change the function declaration at line 1735:

```js
function usePriceFeed(tickersToFetch, toast) {
```

to:

```js
function usePriceFeed(order, fetchKey, toast) {
```

Then, immediately after `const loadingRef = useRef(false);` (line 1751), insert the order ref:

```js
  // Latest fetch order, read by runFetch so a queued follow-up sweep (e.g. one
  // forced after a tab switch floats the active list to the front) uses the newest
  // order, not the order captured when the in-flight sweep began.
  const orderRef = useRef(order);
  orderRef.current = order;
```

- [ ] **Step 9: Point `runFetch` at the order ref.** Inside `runFetch` (lines ~1778-1788), replace `fetchQuoteBatch(tickersToFetch, {` with `fetchQuoteBatch(orderRef.current, {`, and replace `} else if (tickersToFetch.length > 0) {` with `} else if (orderRef.current.length > 0) {`. Then change `runFetch`'s dependency array (line 1803) from:

```js
  }, [tickersToFetch, toast, persistPrices]);
```

to:

```js
  }, [toast, persistPrices]);
```

- [ ] **Step 10: Update the poll-cadence + resetKey.** Replace the `pollMs` initializer (line 1823) `anyMarketOpen(tickersToFetch)` with `anyMarketOpen(order)`; replace the `recompute` line (1825) `anyMarketOpen(tickersToFetch)` with `anyMarketOpen(order)`; change that effect's deps (1829) `}, [tickersToFetch]);` to `}, [order]);`; and change the `usePolledRefresh` call (1833) from:

```js
  usePolledRefresh(refresh, pollMs, OPEN_POLL_MS, tickersToFetch);
```

to:

```js
  usePolledRefresh(refresh, pollMs, OPEN_POLL_MS, fetchKey);
```

- [ ] **Step 11: Route `OverviewView` through the shared const.** At line 9253 replace:

```js
  }, ['NVDA', 'GOOGL', 'C', 'ASML'].map(t => {
```

with:

```js
  }, THESIS_SNAPSHOT.map(t => {
```

- [ ] **Step 12: Bump the SW cache version.** In `sw.js` line 2, change:

```js
const CACHE_NAME   = 'playbook-shell-v33';
```

to:

```js
const CACHE_NAME   = 'playbook-shell-v34';
```

- [ ] **Step 13: Parse-check + confirm no stragglers**

Run:
```bash
node --check app.js && node --check pb-core.js
grep -nE "\btickersToFetch\b" app.js   # expect: NO matches (every ref renamed)
```
Expected: parses clean; the grep returns nothing.

- [ ] **Step 14: Run the full node suite + the fetch-plan anti-drift rows**

Run:
```bash
cd backend/test && for t in *.test.mjs; do echo "== $t =="; node "$t" || break; done
```
Expected: every suite ends with `All ... passed` / `tests passed`; in particular `fetch-plan.test.mjs` is now FULLY green (the two anti-drift rows pass).

- [ ] **Step 15: Run the browser smoke (now GREEN)**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: `ALL PASSED` — including `cold start excludes static lists (picks/hedges/VOO)` and `active Picks list floats to the front of the sweep`. The cold-start auto-poll request count should now be small (positions + ribbon), not ~36.

- [ ] **Step 16: Commit**

```bash
git add app.js pb-core.js sw.js
git commit -m "Split fetch fan-out: lazy/on-view static lists, drop HOLDINGS-bulk + VOO (Phase 2 inc 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Confirm no always-visible view depends on the now-lazy prices + finalize

The dashboard and other fast-tier views must not read a Picks/Hedges/Thesis ticker price directly (they'd now show em-dashes until that tab is visited).

**Files:**
- No code changes unless a defect is found.
- Update (outside the repo, no commit): the `playbook-refactor-priorities` and `playbook-postponed-tasks` memory files.

- [ ] **Step 1: Grep for cross-view price dependencies on the lazy tickers.**

Run:
```bash
grep -nE "DATA\.(NEW_PICKS|HEDGES)" app.js
```
Expected: matches only in `PicksView`/`HedgesView` (render), `OverviewView`/`THESIS_SNAPSHOT` (Thesis), and the search-universe/popular builders (`add(...)`, `popular.push(...)`) which use names, not live prices. If any OTHER component reads `prices['US:' + <a NEW_PICKS/HEDGES ticker>]`, that view depended on the dropped poll — STOP and report it (it would need its own warm entry); do not silently ship em-dashes.

- [ ] **Step 2: Visual confirmation via the smoke output.** Re-read the `node backend/test/verify-refresh-behavior.mjs` output from Task 3 Step 15: confirm the `portfolio "Today" pill renders` row is still green (the dashboard still paints from the fast tier) and the two new rows pass.

- [ ] **Step 3: Confirm the working tree is clean.**

Run: `git status --porcelain`
Expected: empty (all task commits made).

- [ ] **Step 4: Update the memories** (files live outside the repo — no git commit):
  - `playbook-refactor-priorities.md`: add a "PHASE 2 increment 3 — DONE 2026-06-27" entry — fan-out split landed; `buildFetchPlan` added to `pb-core`; static lists lazy/on-view (keep-warm, active-tab float, fast-tier-only resetKey); HOLDINGS-bulk + VOO polling dropped; sw v33→v34; node suite now 12 (added `fetch-plan`); browser smoke extended. Note C2 fan-out (P1 #5) now addressed.
  - `playbook-postponed-tasks.md`: move "Phase 2 increment 3" from in-progress to done; keep the deferred "refresh-confidence UX fix" (root cause B) open with its proxy-reliability evidence intact.

---

## Self-Review

**Spec coverage:**
- §1 Behavior contract: two tiers + keep-warm + immediate refresh + float-to-front + no-restart + drop HOLDINGS/VOO → Tasks 1 (kernel), 3 (warmedLists, view effect, memo, drop). ✓
- §2 Architecture: `THESIS_SNAPSHOT`/`LAZY_LISTS` (Task 3 S1), `warmedLists` (S3), pure `buildFetchPlan` (Task 1), membership-vs-order split incl. fast-tier-only `key` → `usePolledRefresh` resetKey (Task 3 S10), `runFetch` order-ref tweak (S8-S9), `OverviewView` shared const (S11). ✓
- §3 Edge cases: splash gate (S7), poll cadence (S10), first-paint via existing rehydrate (unchanged), overview-tab removability (LAZY_LISTS entry). ✓
- §4 Testing: node kernel suite (Task 1) + extended browser smoke (Task 2 RED → Task 3 GREEN) + cross-view dependency grep (Task 4). ✓
- §5 Mechanical/deploy: `pb-core`+`app.js` edits, `sw.js` v33→v34, no new file ⇒ no allowlist change, no worker impact. ✓
- §6 Increment breakdown: kernel → RED browser test → wire → verify maps to Tasks 1-4. ✓

**Placeholder scan:** no TBD/TODO/"add error handling"/"similar to". Every code step shows the exact old/new text. The one conditional note (Task 1 Step 5 anti-drift rows) explains exactly which rows stay red until Task 3 and why — not a placeholder. ✓

**Type consistency:** `buildFetchPlan({fastTiers, lazyLists, warmed, activeView}) => {order: [{market,ticker}], key: string}` is defined in Task 1 and consumed identically in Task 3 Step 4. `usePriceFeed(order, fetchKey, toast)` defined in Task 3 Step 8 matches the call in Step 5 and the internal uses (orderRef from `order`, resetKey from `fetchKey`). `priceKey`/`anyMarketOpen`/`fetchQuoteBatch`/`usePolledRefresh` signatures unchanged. ✓
