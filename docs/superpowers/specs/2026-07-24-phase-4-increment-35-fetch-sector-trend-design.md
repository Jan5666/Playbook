# Phase 4 · Increment 35 — `fetchSectorTrend` → `pb-modals.js` (design)

## Why

Phase 4 peels large view/modal components out of the no-build `app.js` UMD monolith into the
browser-only classic-script buckets (`pb-views.js`, `pb-modals.js`), shrinking the render-time
`window.PBApp` bridge toward **only genuinely-shared members** — anything consumed by just one bucket
(and not by root `App`) belongs *in* that bucket, not on the bridge.

inc-34 called the bridge "now holds only genuinely-shared members." A fresh 39-member caller inventory
shows one last mis-classification: `fetchSectorTrend` (`app.js:4857–4890`, the sector-ETF multi-horizon
trend reader) is **pb-modals-only**. It carried a deliberate author annotation — "fetchSectorTrend stays
above (impure Yahoo reader, bridged for pb-modals SectorDetailModal)" — but that was over-cautious: the
"impure readers must stay in app.js" rule exists for readers coupled to **root `App` state or `DATA`
infra** (`parseImportFile`, `ocrImageFile`, `searchListingsMulti`, `useHotStocks`, `buildSuggestions`,
`resolvePositionSector`). `fetchSectorTrend` reads **neither** — its only free identifiers are
`PBContent` / `PBData` module globals the bucket already reads directly, plus its own module-private
cache. It is impure in the I/O sense but **app-state-uncoupled**, so it is mechanically a clean verbatim
move — the same self-correcting cadence by which inc-31→34 each corrected a prior over-cautious "stays
bridged" call.

A fresh caller inventory confirms it is **pb-modals-only**:

- `pb-modals.js` consumes it in **1 modal** — `SectorDetailModal` (`window.PBApp` lead read + one bare
  call in the trend-loading effect).
- **Zero** root-`App` callers, **zero** `pb-views.js` callers (the only `app.js` occurrences were the
  definition, its two `PBContent` aliases + private cache, the bridge publish line, and one comment).
- It works today because `app.js` runs at **global scope** (no IIFE wrapper), so the top-level
  `async function fetchSectorTrend()` is a *global* that the bucket also redundantly re-reads from
  `window.PBApp`.

This is a clean bridge-shrink — the last one available under the pure verbatim-move pattern. It shrinks
the bridge by 1 (**39 → 38**), reaching the **bridge floor**: every remaining member is genuinely shared
across both buckets, consumed by root `App`, or an impure/anchored reader coupled to `DATA`/root infra.

## Scope

Move into `pb-modals.js` (verbatim): `async function fetchSectorTrend(sectorName)` (`app.js:4857–4890`,
~34 lines) + its module-private `const SECTOR_TREND_CACHE = {}` (`app.js:4856`) + the explanatory
SPDR-sector-ETF comment (`app.js:4850–4853`), placed beside the inc-34 `useSwipeDownToClose` block just
after the IIFE module-read header. Bucket-private after the move (hoisted `async function`, no lead read
needed). Pure display-tier network read — no money/alert code (rules #3/#4 unaffected).

Re-derived in the bucket (not moved as `app.js` aliases): the two `PBContent` binds `SECTOR_ETF` /
`SECTOR_TREND_WINDOWS` and the `PBData` bind `fetchViaProxies` become **IIFE reads** at the top of
`pb-modals.js` (all three modules load before the bucket, so top-of-IIFE reads are safe). The `app.js`
aliases `const SECTOR_ETF = PBContent.SECTOR_ETF;` / `const SECTOR_TREND_WINDOWS =
PBContent.SECTOR_TREND_WINDOWS;` are **removed** — `fetchSectorTrend` was their only `app.js` consumer.
`fetchViaProxies`'s `app.js` alias stays (used app-wide); the bucket reads `PBData.fetchViaProxies`.

Stays put in `app.js`: nothing else moves. The block sat between the inc-32 treemap-math pointer comment
(above) and the `HeatmapView` bind (below), both unrelated and unchanged.

## Dependency inventory

Move block = the SPDR comment + `SECTOR_TREND_CACHE` + `async function fetchSectorTrend(sectorName)`.

| identifier | classification |
|---|---|
| `SECTOR_ETF` | `PBContent.SECTOR_ETF` — **new IIFE read** (`app.js` alias removed; was fetchSectorTrend-only) |
| `SECTOR_TREND_WINDOWS` | `PBContent.SECTOR_TREND_WINDOWS` — **new IIFE read** (`app.js` alias removed) |
| `fetchViaProxies` | `PBData.fetchViaProxies` — **new IIFE read** (`app.js` alias stays; used app-wide) |
| `SECTOR_TREND_CACHE` | module-private cache — **moves with the function** (bucket-private const) |
| `Date`, `Math`, `JSON`, `Array`, `isFinite`, `Number` | native globals (free) |
| `sectorName` | parameter — self-contained |

⇒ **0 new bridge members, +3 new IIFE reads (2 `PBContent`, 1 `PBData`), 0 injected lead reads** (a
hoisted bucket-private function; `SectorDetailModal` calls it directly). One lead read *shrinks*:
`SectorDetailModal`'s `const { Icon, useBodyScrollLock, fetchSectorTrend } = window.PBApp;` drops
`fetchSectorTrend`.

## Bridge / registration

- `window.PBApp` publish line: **remove** `fetchSectorTrend` (bridge **39 → 38**).
- **Not** registered on `window.PBModals` — nothing outside `pb-modals.js` consumes it (the inc-31
  `SectorWeightRows` / inc-33 `useContainerWidth` / inc-34 `useSwipeDownToClose` precedent).
- `SectorDetailModal`'s lead read drops `fetchSectorTrend`; the bare call
  (`fetchSectorTrend(sectorName).then(…)`) is unchanged — it resolved to the `app.js` global before and
  resolves to the bucket-local function now. `app.js` retains a pointer comment where the code was.

## Wiring

- `sw.js` `CACHE_NAME` **v85 → v86** — the only shipped-file change; both files already wired (no
  `index.html` / `SHELL_ASSETS` / `static.yml` / harness edits; `deploy-assets` stays green).
- **Content guard (required — inc-16 `SECTOR_FWD_PE` precedent):** two `PBContent` binds leave `app.js`,
  so `backend/test/content.test.mjs` (the "delegates the content blocks to PBContent" test) is updated
  to check `(appSrc + modSrc)` for the `SECTOR_ETF` / `SECTOR_TREND_WINDOWS` binds instead of `appSrc`
  alone. The anti-inline asserts (`!appSrc.includes('const SECTOR_ETF = {')` etc.) are untouched —
  nothing is inlined; the literal objects still live in `pb-content.js`.

## Encoding note

`app.js` and `pb-modals.js` are **BOM + LF** (verified 0 CRLF). The moved block carries one em-dash
(`—`) in its authored comment (`over time — it's …`); it is captured **byte-for-byte** from the `app.js`
source and reused verbatim as the insertion, never retyped. Moved via a Node slice script (read/write
`utf8`, split/join `\n`, keep the BOM, content-anchored boundaries, replacement functions to avoid `$`
expansion) — never the Edit tool.

## Read-out (measured)

- `node --check` app.js / pb-modals.js / sw.js: **OK**.
- Encoding after move: both **BOM + LF**, U+FFFD scan **clean** (0 replacement chars in either file).
- Anti-drift: `function fetchSectorTrend` = **0** app.js / **1** pb-modals.js / **0** pb-views.js;
  `SECTOR_TREND_CACHE` = **0** app.js code (1 pointer-comment mention) / **1** definition pb-modals.js;
  `const SECTOR_(ETF|TREND_WINDOWS) = PBContent` binds = **0** app.js / **2** pb-modals.js;
  `fetchSectorTrend` **absent** from the `window.PBApp` publish line (bridge count **38**); **0** lead
  reads pull it from `window.PBApp`; 1 bare call site + 1 definition intact.
- Full node suite (money gate + content guard + deploy-assets): **28/28 pass** (`content.test.mjs` green
  with the updated `(appSrc + modSrc)` guard).
- Render gate: the committed `verify-refresh-behavior.mjs` mount gate does **not** mount in this remote
  Linux container (fails identically on pristine `HEAD` — a container/harness setup artifact, not a
  regression). Validated instead with two standalone throwaway probes: (1) a **load-time smoke** —
  execute the `pb-modals.js` IIFE under minimal `React`/`PB*`/`window` stubs → all **11 modals** register
  (incl. `SectorDetailModal`), proving the new IIFE-top `SECTOR_ETF` / `SECTOR_TREND_WINDOWS` /
  `fetchViaProxies` reads don't throw at load; (2) a **function probe** — expose `fetchSectorTrend` and
  invoke it with a stubbed `fetchViaProxies` returning a Yahoo-chart-shaped payload → the unsupported
  branch returns `{unsupported:true}`, a supported sector returns a `+10.0%` 1-month trend, and a second
  call hits the 6-hour cache (same entry reference) — proving `SECTOR_ETF` / `SECTOR_TREND_WINDOWS` /
  `fetchViaProxies` / `SECTOR_TREND_CACHE` all resolve in-bucket-scope. No live network / money
  side-effects.
- app.js: 5078 → 5037 lines (~41 net out); bridge 39 → 38 (**bridge floor reached**); `sw`
  `CACHE_NAME` v85 → v86; `architecture-map.html` bridge list + count brought current (38).

## Out of scope / deferred

No cost-basis / import-matching / alert-eval / backup code touched. The remaining 38 bridge members are
all genuinely shared across both buckets, consumed by root `App`, or impure/anchored readers coupled to
`DATA`/root infra (`parseImportFile`, `ocrImageFile`, `searchListingsMulti`, `useHotStocks`,
`buildSuggestions`, `resolvePositionSector`, the `parseCashFlow*` cash-flow parsers blocked by the
shared `loadScriptOnce` CDN loader) — none is a verbatim-move candidate. **The Phase 4 structural
extraction is complete at the bridge floor.** The post-refactor plan is `SECURITY_ROADMAP.md`.

## Commit note

`refactor(modal): relocate fetchSectorTrend into pb-modals.js (inc 35)` — branch
`claude/refactor-plan-continuation-7tf0bb` (off latest `origin/main` @ inc-34 / PR #43). No PR, never
`main` — Jan reviews and lands.
