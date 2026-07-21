# Phase 4 increment 24 — the view tier's core: `DashboardView` -> `pb-views.js`

**Date:** 2026-07-21
**Branch:** `claude/refactor-plan-q74cry` (off latest `origin/main` @ inc-22/PR #33; follows inc-23)
**Status:** executed — all gates green (see measured read-out)

## Goal

Move the dashboard tab view `DashboardView` (`app.js`, **299 lines**) plus its single-caller
growth-chart cluster — `CHART_MONTHS` + `chartDayLabel` + `buildTimeAxisTicks` + `PortfolioLineChart`
(**406 lines**, 3973–4378) — into `pb-views.js` as a **byte-identical verbatim move**. Second
non-modal view increment (after inc-23 `HeatmapView`). Display + delegate: the overall-profit / today
aggregation is formatted from pb-core helpers that **do not move**; the add-contribution flow is handed
to the already-extracted `ContributionModal`/`ContributionImportModal`.

## Why this is a display move (not money-tier)

`DashboardView` **displays** aggregates — `overallProfit = totalValue − totalContrib` (via the bridged
`computeFxSnapshot`), per-market growth via `contribInDisplay` / `convertCcy` / `quoteTradedToday`, all
**pb-core functions that stay in pb-core**. `PortfolioLineChart` already delegates its date-merge to
`PBCore.forwardFillPortfolio` (pinned by `portfolio-fill.test.mjs`). No cost-basis is re-derived, no
order placed, no `pb.*` key written. So the pin is a **before/after render probe** (Dashboard digest),
not a new characterization-test file.

## Dependency inventory (every free identifier classified)

Move blocks = the cluster (3973–4378) + `DashboardView` (4898–5196). Exhaustive residue analysis
(every bare `name(` call + every CAPS global, minus locals/natives/props/already-wired) yields **+2
bridge, +5 IIFE reads** — richer than the pre-inventory estimate (which assumed +1 bridge / +0 IIFE),
because the dashboard pulls the growth-history + contribution-valuation helpers.

### Reaches app.js internals -> bridge (`window.PBApp`) — **+2 (39 -> 41)**

- **`PortfolioPieChart`** — a **multi-caller** (`DashboardView` **and** `TFSAView` at `app.js:8168`),
  so it **stays in app.js** and is bridged. Its single-caller `SectorHoldingsPopup` and the
  `resolvePositionSector` helper stay with it.
- **`fmtNum`** — the shared number formatter (**14 app.js callers**), stays in app.js, now bridged for
  the moved view.
- Already bridged: `Icon`, `fmt`, `fmtCcy`, `fmtCcySigned`, `computeFxSnapshot`.

Injected `DashboardView` lead read:
`const { Icon, fmt, fmtCcy, fmtCcySigned, computeFxSnapshot, PortfolioPieChart, fmtNum } = window.PBApp;`

### Reads module globals -> IIFE — **+5** (on top of inc-23's five)

`CURRENCY_SYMBOLS` (PBContent), `MARKET_CURRENCY` / `contribInDisplay` / `quoteTradedToday` (PBCore),
`fetchHistory` (PBData) — added at the top of the bucket IIFE. `convertCcy` / `positionCostCcy` /
`marketCurrency` / `priceKey` were already IIFE-read by inc-23; `PBCore.forwardFillPortfolio` and the
`PBStore.*` hooks are inline global reads. **The cluster needs no `window.PBApp` lead read** — it uses
only IIFE-read globals + inline `PBCore`/`PBStore` + its own axis helpers.

### `ContributionModal` + `ContributionImportModal` read at render time

`pb-modals.js` loads **after** `pb-views.js`, so `DashboardView` reads both in-body:
`const ContributionModal = PBModals.ContributionModal;` / `…ImportModal`. `DashboardView` uses **no
`DATA`** (its `DATA` usage lived in the staying `resolvePositionSector`/`PortfolioPieChart`), so no
render-time `DATA` read is injected. The app.js `ContributionModal`/`ContributionImportModal` aliases
(their only callers were in `DashboardView`) are left in place as harmless module-global binds.

### `portfolio-fill.test.mjs` source guard follows the chart

`PortfolioLineChart` carried `PBCore.forwardFillPortfolio(` out of app.js. The delegation guard
(previously `appSrc.includes(...)`) now checks **`appSrc + viewsSrc`**, and the anti-inline "naive
per-date sum is gone" invariant spans both files — following the code to the bucket without weakening
(the inc-16 `content.test.mjs`/`SECTOR_FWD_PE` precedent).

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; the body carries literal `£ · —` and the
`−` minus escape). Two blocks validated in memory against seven content anchors (cluster
comment/CHART_MONTHS/end, the staying `resolvePositionSector` comment, DashboardView fn/end, the staying
`HoldingRow` comment) before an atomic write of both files.

Into `pb-views.js` (before the registration block; hoisting makes order moot): the cluster (bucket-
private) then `DashboardView` with its lead reads; register `window.PBViews.DashboardView = DashboardView;`
after the `HeatmapView` registration. `PortfolioLineChart` + the axis helpers stay bucket-private (no
external caller).

In `app.js`: the cluster span -> a 2-line comment (no bind — `PortfolioLineChart` has no remaining app.js
caller); the `DashboardView` span -> a pointer comment + `const DashboardView = PBViews.DashboardView;`
(TDZ-safe; the App tab-switch call site is inside a function body). **Add `PortfolioPieChart, fmtNum`**
to the bridge publish line (both defined before it).

## Wiring

- `sw.js` `CACHE_NAME` **v73 -> v74**. Only shipped-file wiring.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the harnesses — the bucket is already wired.
- `architecture-map.html` — bridge **39 -> 41** (+`PortfolioPieChart`, +`fmtNum`) in the count/narrative
  and the literal member list, plus an inc-24 history note.
- `backend/test/portfolio-fill.test.mjs` — delegation guard spans `app.js + pb-views.js`.
- `REFACTOR_STATUS.md` — Done + Current-state (bridge **41**, `sw` **v74**).

## Verification gate

1. `node --check` app.js + pb-views.js.
2. Full node suite (**27**; money gate unaffected; content guard; deploy-assets; **portfolio-fill guard
   updated to follow the chart**).
3. Anti-drift greps: `function DashboardView`/`function PortfolioLineChart`/`const CHART_MONTHS` = 0
   app.js / 1 pb-views.js; `PortfolioPieChart`/`fmtNum`/`resolvePositionSector` still 1 in app.js
   (stay); pointer + bind; registration; **bridge = 41**; no app.js `PortfolioLineChart` bind.
4. **Verbatim proof:** cluster + DashboardView bodies exact substrings of `HEAD:app.js` (aside from the
   lead reads), absent from app.js.
5. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED**.
6. **Render probe** (before & after): US + crypto-in-ZAR seed; Dashboard tab (profit summary + today
   pill + line chart) + Heatmap tab. **Digest identical**. U+FFFD scan; BOM/NUL/LF integrity.

## Out of scope / deferred

- `PortfolioPieChart`, `SectorHoldingsPopup`, `resolvePositionSector` stay (shared / single-caller of the
  staying pie chart). The remaining tab views (`CurrentView`, `WatchlistView`, `TFSAView`) are future
  increments.
- **`FxSummary`** (`app.js`) remains vestigial dead code — flagged for a separate cleanup, untouched.

## Commit note

Development on `claude/refactor-plan-q74cry`; commit + push to the feature branch. **No PR; `main` never
pushed.** Scratchpad scripts never committed.

## Measured read-out (2026-07-21, on execution)

All gates green.
- **Render probe green before AND after** the move, **byte-identical digest**:
  `{"dashSummary":"OVERALL PROFIT −$1,825.00","todayPill":"▲+$171.25 · +5.70%","hasLine":true,`
  `"svgCount":12,"heatDom":true,"heatErr":null}`. Both runs ALL PASSED.
- **Verbatim:** the 406-line cluster and the 299-line `DashboardView` are exact substrings of
  `HEAD:app.js` (aside from the injected lead reads) and absent from the new app.js.
- `node --check` OK. Full node suite **27/27** (money gate + content guard + deploy-assets +
  portfolio-fill guard, now spanning app.js + pb-views.js). U+FFFD = 0; BOM + LF preserved; app.js NUL
  0->0, pb-views.js NUL 2->2; no CRLF.
- Anti-drift: `function DashboardView`/`function PortfolioLineChart`/`const CHART_MONTHS` **0 app.js / 1
  pb-views.js**; `function PortfolioPieChart`/`function fmtNum`/`function resolvePositionSector` **1 in
  app.js**; pointer + `const DashboardView = PBViews.DashboardView`; registration after `HeatmapView`;
  **bridge 41** with `PortfolioPieChart, fmtNum`; no app.js `PortfolioLineChart` bind.
- Mount gate `verify-refresh-behavior` **ALL PASSED**.

**Bucketing economics, measured:**
- `app.js` **-699 net** (406-line cluster -> 2-line comment; 299-line view -> 4-line pointer + bind),
  `pb-views.js` **+721**, `sw.js` **v73 -> v74**. Zero index/static/harness edits (one test-guard update).
- **Bridge 39 -> 41 (+PortfolioPieChart, +fmtNum), IIFE +5.** The exhaustive inventory caught the
  contribution-valuation + growth-history helpers the estimate missed.

**Conclusion:** the dashboard view + its growth-chart cluster are extracted; `pb-views.js` now holds
**8 views + the Heatmap fullscreen chrome + the growth-chart cluster**; bridge **41**; `sw` `CACHE_NAME`
**v74**. Remaining tab views: `CurrentView`, `WatchlistView`, `TFSAView`.
