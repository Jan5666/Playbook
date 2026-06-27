# Phase 2 — Increment 3: fetch fan-out split (lazy/on-view static lists)

**Date:** 2026-06-27
**Branch base:** `main` (head `ac4f8b7`, post-Phase-2 inc 1+2 / PR #5)
**Scope this round:** Reduce the price-feed fan-out — poll only the user's own universe on the routine cadence; make the static recommendation lists (`DATA.NEW_PICKS`, `DATA.HEDGES`, the Thesis snapshot) lazy/on-view. Drop dead polling (`DATA.HOLDINGS` bulk, `US:VOO`).

Companion to [`playbook-refactor-priorities`](../../../) (Phase 2 = P1 "consolidate data layer"; this is the C2 fan-out win, P1 item #5) and the inc 1+2 design (`docs/superpowers/specs/2026-06-26-phase-2-data-layer-design.md`), which explicitly deferred this increment to "its own round."

## Goal

The price feed currently polls **36 symbols every 45s** through a ladder of shared public CORS proxies (measured live — see Diagnosis). Of that 36, only the user's own positions/watchlist/alerts + the index ribbon are always on screen; the rest is static recommendation data the user sees only when they open the Picks / Hedges / Thesis tabs. Cutting the routine sweep down to the user's own universe (~6 symbols in the common case) lightens proxy load by ~83%, so the one reliably-fast proxy (corsmirror) stops getting rate-limited and the user's holdings refresh fast and reliably.

**Non-goals this round (deferred — see "Diagnosis captured / deferred"):** the refresh-button **feedback/confidence UX** (a distinct root cause); moving the FX fetchers out of `app.js`; any Worker-side shared quote cache.

## Diagnosis captured / deferred (do not lose this)

The user reported holdings/watchlist prices feel "slow and behind," the refresh button "feels like it's not working," and there's "no way to be sure prices are up to date / no way to force refresh." A live systematic-debugging pass (2026-06-27) found **two distinct root causes**:

**Root cause A — fan-out (THIS increment fixes it).** Live proxy probe for one Yahoo daily quote:

| Proxy | Latency | Result |
|---|---|---|
| corsmirror | 455 ms | ✅ OK (the only reliably-fast one; floats to front via `lastGoodProxy`) |
| cors.lol | 612 ms | ❌ HTTP 429 (rate-limited) |
| allorigins-get | 2780 ms | ✅ OK (slow) |
| allorigins-raw | 3336 ms | ✅ OK (slow) |
| corsproxy.io | 261 ms | ❌ HTTP 403 (blocks deployed origins) |
| codetabs | 871 ms | ❌ HTTP 400 |

With only corsmirror healthy, pushing 36 symbols/45s through it makes *it* start 429-ing too; symbols then cascade to the 2.8–3.3 s fallbacks or time out at 8 s, and `fetchQuoteBatch` runs a **second retry pass** — turning a ~2 s sweep into 10–30 s with some prices returning blank. The button **wiring is correct** (`verify-refresh-behavior.mjs` passes: click → fresh cache-busted sweep, positions-first). The slowness is load, not a bug.

**Root cause B — no refresh feedback (DEFERRED to a future increment).** Independent of fan-out:
- Status chip shows **HH:MM only** ([app.js:3260](../../../app.js)) → pressing refresh within a minute shows no visible change.
- A press mid-sweep is **silently queued** (`pendingForceRef`, [app.js:1812-1815](../../../app.js)) and waits out the current slow sweep → looks ignored.
- On proxy failure, `lastUpdate` doesn't move and there's **no error** until two consecutive fails.
- Market-closed → prices legitimately unchanged → indistinguishable from "didn't work."

**Deferred follow-up (tracked in `playbook-postponed-tasks` memory):** a focused "refresh confidence" UX increment — live "Updated Ns ago" that ticks; explicit Updating… / Updated ✓ / Couldn't refresh — tap to retry states; acknowledge a queued mid-sweep press immediately; success confirmation even when numbers are unchanged. Optional deeper fix: a Worker-side shared quote cache to retire the public proxies (P1/Phase 5).

## Constraints (inherited)

- **No build step.** Changes live in `app.js` (React hooks/components) + a pure helper in `pb-core.js`. No new `<script>` file, so no `index.html`/allowlist change; bump `sw.js` cache version because `app.js`/`pb-core.js` change.
- **`pb-core.js` = pure, worker-shared.** The new fan-out *kernel* (set-union + ordering + membership key) is pure → it goes in `pb-core.js` and is unit-tested in node. The React wiring (state, effects) stays in `app.js`.
- **Sequencing rule:** pin current behavior with a test before changing it. The pure kernel gets node tests; the end-to-end fan-out change is pinned by extending `verify-refresh-behavior.mjs` (the headless-browser smoke — node suites never load `app.js` in a browser).
- **Honor the user's decisions** (below): keep-warm lifecycle, immediate refresh on view-change, float active tab to front, never restart an in-flight sweep on tab switch.

## Section 1 — Behavior contract (user decisions)

1. **Two tiers.** *Fast tier* (always polled): `positions`, `watchlist`, `alerts`, `ribbonItems`. *Lazy tier* (polled only once their tab has been visited): `picks → DATA.NEW_PICKS`, `hedges → DATA.HEDGES`, `overview → THESIS_SNAPSHOT`.
2. **Keep-warm for the session.** Once a lazy tab is visited, its list stays in the poll set until reload (the set only grows). Chosen over drop-on-leave for warm returns.
3. **Refresh immediately on view change.** Entering a lazy tab triggers an immediate refresh so its prices are fresh within a tick; the rehydrated last-known cache paints instantly meanwhile (no em-dashes).
4. **Float the active tab to the front of the fetch order**, so the prices on screen refresh first. On fast-tier views (dashboard/holdings/watchlist) the order is positions-first, exactly as today.
5. **Never restart an in-flight sweep on tab switch.** Let the running sweep finish; rapid switching collapses to at most one follow-up sweep; increment-2's in-flight de-dupe stops the same upstream URL being hit twice.
6. **Drop dead polling:** remove bulk `DATA.HOLDINGS` and `US:VOO` from the universe entirely. `DATA.HOLDINGS` is never rendered as a live list — only the 4-name Thesis snapshot uses it, and that becomes the `overview` lazy list; the rest only feeds search/detail, which fetch on demand. `US:VOO` is polled but never read.

## Section 2 — Architecture

**`THESIS_SNAPSHOT`** — a new shared const `['NVDA','GOOGL','C','ASML']` consumed by *both* `OverviewView` (currently hardcoded inline at [app.js:9253](../../../app.js)) and the lazy-list map, so the two can't drift.

**`LAZY_LISTS`** — a map from view key → that view's ticker-key array:
`{ picks: NEW_PICKS keys, hedges: HEDGES keys, overview: THESIS_SNAPSHOT keys }` (all `US:`).

**`warmedLists` state** — `useState(() => new Set())` of visited lazy-view keys. A `useEffect` on `view`: if `view ∈ LAZY_LISTS`, add it (idempotent) and call `refreshPricesNow()`.

**Pure kernel in `pb-core.js`** (unit-testable, no React/DOM):
- `buildFetchPlan({ fastTiers, lazyLists, warmed, activeView }) → { order, key }` where
  - `order` = active lazy list (if `activeView` is lazy) **first**, then the fast tiers in their fixed sequence, then the remaining warmed lazy lists — deduped by `priceKey`, preserving first occurrence, returned as `[{market,ticker}]`.
  - `key` = the **membership signature**: the unique price-keys, **sorted**, joined. Order-independent by construction.
- `app.js` binds it (`const buildFetchPlan = PBCore.buildFetchPlan`) and computes `{ order, key }` in the `tickersToFetch` `useMemo` (renamed/retained), deps `[positions, watchlist, alerts, ribbonItems, warmedLists, view]`, then calls `usePriceFeed(order, key, toast)`.

**Data flow / the membership-vs-order split (the key correctness point):**
- `order` → passed to the feed for `fetchQuoteBatch` (paint priority) and to `anyMarketOpen`. Changes on every tab switch (float) — that's fine, it must not *trigger* fetches.
- `key` → `usePriceFeed` takes it as a second arg and forwards it to `usePolledRefresh` as `resetKey` ([app.js:243-261](../../../app.js)) **instead of the ticker array** (`usePolledRefresh` is called inside `usePriceFeed` at [app.js:1833](../../../app.js), so the key is threaded through the hook, not passed from `App`). Today `resetKey = tickersToFetch` fires an immediate `refresh()` whenever its identity changes; if we fed it the reordered array, every tab switch would fire a redundant full sweep — exactly the thrash the user flagged. Keying on the membership signature means **reorders never refetch; only genuine membership changes do.**
- The only fetch trigger on a tab switch is the explicit `refreshPricesNow()` in the view effect, whose `refreshNow` already (a) completes any in-flight sweep instead of restarting, (b) collapses rapid switches to one follow-up via `pendingForceRef`, (c) fetches now if idle.

**One mechanism tweak in `usePriceFeed`:** `runFetch`'s queued follow-up sweep currently reuses the `order` captured when it started. Make `runFetch` read the latest `order` from a ref at the top of each `do…while` iteration so the post-switch follow-up sweep uses the **floated** order (the just-opened tab paints first). No other behavior change.

## Section 3 — Edge cases to preserve

- **Splash gate** ([app.js:2927-2934](../../../app.js)) keys off `tickersToFetch.length === 0`. The fast tier includes `ribbonItems` (default index strip is non-empty), so cold start is never empty → gate still resolves normally.
- **Poll cadence** `anyMarketOpen(tickersToFetch)` ([app.js:1823-1829](../../../app.js)) decides 45s vs 5min. The ribbon carries US indices, so US-open detection still works on the slimmed cold set; warmed lazy lists are US too. Pass it `order` (membership-equivalent for this purpose).
- **First paint on entering a lazy tab:** `usePriceFeed` already rehydrates last-known prices for *all* cached keys on open, so a warmed list paints from cache instantly, then the immediate refresh updates it.
- **`overview`/Thesis tab:** if the user later deletes that tab (they've said they may), just remove the `overview` entry from `LAZY_LISTS` and the `THESIS_SNAPSHOT` const — no other coupling.

## Section 4 — Testing

- **Node unit tests** for the pure kernel (`backend/test/fetch-plan.test.mjs`, new): float-active-to-front ordering; fast-tier-first when no lazy view active; dedupe preserves first occurrence; **`key` is identical under reorder but differs on membership change** (the anti-thrash invariant); warmed-but-inactive lists included in `order` after the fast tier. Plus an anti-drift guard: `app.js` binds `buildFetchPlan` from `PBCore` and defines no local copy.
- **Headless-browser smoke** — extend `backend/test/verify-refresh-behavior.mjs`:
  - Cold start (no lazy tab visited) requests **only** the fast tier — assert `NEW_PICKS`/`HEDGES`/`VOO` symbols are **absent** from the auto-poll log (today they're present; this is the regression that proves the fan-out dropped).
  - After navigating to Picks, its symbols appear **and** lead the next sweep (floated to front), with no duplicate redundant sweep from the reorder.
  - Switching tabs mid-sweep does not restart the in-flight sweep (request count for the in-flight symbols doesn't double).
- Full existing node suite (11) stays green; `node --check pb-core.js app.js`.

## Section 5 — Mechanical / deploy

- `pb-core.js`: add `buildFetchPlan` (+ export). `app.js`: `THESIS_SNAPSHOT`, `LAZY_LISTS`, `warmedLists` state + view effect, rework the `tickersToFetch` memo to `{order,key}`, feed `order` to the batch + `key` to `usePolledRefresh`, the `runFetch` ref tweak, and route `OverviewView` through `THESIS_SNAPSHOT`.
- `sw.js`: bump cache version (v33 → v34) so the changed `app.js`/`pb-core.js` are picked up. No new file → no `index.html`/`static.yml` allowlist change.
- **No worker/wrangler impact.**

## Section 6 — Increment breakdown

- **Step A — pure kernel.** RED-first `fetch-plan.test.mjs` → implement `buildFetchPlan` in `pb-core.js` → green → commit.
- **Step B — wire into `app.js`.** `THESIS_SNAPSHOT`/`LAZY_LISTS`/`warmedLists`/view effect; rework `tickersToFetch` to `{order,key}`; feed order/key; `runFetch` ref tweak; drop HOLDINGS+VOO; route `OverviewView`. Bump sw cache. Extend `verify-refresh-behavior.mjs`. Full sweep + browser smoke green → commit.
- **Step C — verify + memories.** Browser smoke confirms cold-start excludes static lists and Picks floats to front without a redundant sweep; update `playbook-refactor-priorities` (inc 3 done) and `playbook-postponed-tasks` (refresh-confidence UX still deferred + proxy-reliability evidence retained).

## Open items / risks

- Verify no dashboard/other always-visible view reads a Picks/Hedges/Thesis ticker price directly (would now show em-dashes until that tab is visited). Grep + browser smoke. From exploration, only the three lazy views consume those prices, but confirm in the plan.
- `buildFetchPlan` lives in `pb-core` (pure) though it encodes app-specific tier order; acceptable — it takes the tiers as arguments, so it stays generic and the app supplies the policy.
