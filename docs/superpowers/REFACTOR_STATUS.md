# Refactor status — Phase 4 modal/view extraction (living roadmap)

**Purpose:** the single doc a fresh chat reads to resume the refactor without re-deriving context.
Keep it current at the end of each increment. Canonical detail lives in
`docs/superpowers/{specs,plans}/`.

**Branch:** `claude/refactor-plan-continuation-yywg24` (off latest `origin/main` @ inc-24/PR #34). **Jan
reviews + lands; never push `main`, never open a PR.** Last landed on `main`: inc 23–24
`HeatmapView`/`DashboardView` (PR #34); before them inc-22 `PositionModal` (PR #33), inc 20–21
Buy/`SellModal` (PR #32), inc-19 `ImportModal` (PR #31), inc-18 `AlertsModal` (PR #30), inc 15–17 (PR #26)
and feature PRs #27–#29 (rotation tab, watchlist suggestions), which had bumped `sw` `CACHE_NAME` to v67
and the bridge to 33 members without a refactor increment.

## The refactor in one paragraph

`app.js` is a no-build, no-JSX React UMD monolith. Phase 4 peels large view/modal components out
into **browser-only classic-script buckets** — `pb-views.js` (views) and `pb-modals.js` (modals) —
that read shared `app.js` internals through a **render-time `window.PBApp` bridge** and read PB*
module globals directly in the bucket IIFE. Each increment moves one component (or a single-caller
subtree) **verbatim**, keeping behavior byte-identical. The bridge grows when a bucket needs a new
shared app.js internal, and shrinks when a single-caller helper is relocated into the bucket.

## Done

- **Phase 0–3** complete; **Phase 4 content extraction** inc 1–6 (`pb-content.js`).
- **Views** (inc 7–10): HotTopics, Picks, Hedges, Rules, Overview -> `pb-views.js`.
- **Modals** (inc 11–14): SectorAllocation, SectorDetail, Contribution, ContributionImport ->
  `pb-modals.js` (merged in PR #25).
- **inc-15** `DetailModal` -> `pb-modals.js` (bridge 17->29).
- **inc-16** DetailModal sub-component **subtree** (PriceChart/FundamentalsBlock/WatchlistControl/
  EarningsBadge/IndicatorValueBlock/IndicatorAbout/HoldingNotesControl + 5 helpers) -> bucket;
  **bridge shrank 29->23**; `content.test.mjs` guard followed `SECTOR_FWD_PE` to the bucket.
- **inc-17** `SettingsModal` + single-caller `TabReorderList` -> bucket; **bridge 23->31**; +4 IIFE
  reads (`useLayoutEffect` + PBContent `DISPLAY_CURRENCIES`/`MARKETS`/`RIBBON_CATALOG`).
- **inc-18** `AlertsModal` -> bucket; **safe verbatim move, 0 new bridge members / 0 new IIFE reads**
  (`Icon`, `fmt`, `timeAgo`, `useSwipeDownToClose`, `useBodyScrollLock` already bridged; `useRef`
  already IIFE-read). Display + CRUD only — alert eval + money math stay in pb-core, untouched.
- **inc-19** `ImportModal` (~612 lines) -> bucket; **+4 bridge / +7 IIFE reads**. Display + delegate:
  the multi-caller `TickerSearch` and the impure readers `parseImportFile`/`ocrImageFile`/
  `searchListingsMulti` stay in app.js (bridged, per the inc-14 `parseCashFlowFile` precedent); the 7
  pb-import.js matchers are the **first `PBImport` IIFE reads** in the bucket; `DATA` (`window.PB_DATA`)
  is read **at render time** (data.js loads after the bucket — the `pb-views.js` pattern). No
  cost-basis / import-matching / backup code moved — the import mutator lives in the data layer (via
  the `onImport` prop).
- **inc-20** `BuyModal` (~92 lines) -> bucket; **+1 IIFE read (`positionCostCcy`) / +0 bridge**. First
  rule-#3 money-tier move: the in-body average cost-basis re-blend
  (`(shares*costBasis + n*price)/newTotalShares`) + the `onBuy(..., costCcy)` payload are byte-identical
  (verbatim), pinned by a before/after render probe (US + crypto-in-ZAR). `Icon`/`useSwipeDownToClose`/
  `useBodyScrollLock`/`sanitizeDecimalInput` already bridged; the buy mutator stays in the data layer.
- **inc-21** `SellModal` (~138 lines) -> bucket; **+0 IIFE / +0 bridge** (all deps already wired). The
  %<->shares sync (both directions + chip), `pnl = (price - costBasis) * shares` (sign + format), the
  validity cap (shares <= holding), and the 6-arg `onSell` payload (**no** costCcy) are byte-identical
  (verbatim), pinned by a before/after render probe (sell + loss + over-holding). Realized
  gain/proceeds stay in the `onSell` mutator (data layer).

- **inc-22** `PositionModal` (~326 lines) -> bucket; **+1 bridge (`MarketPicker`) / +0 IIFE reads**. Third
  and final money-tier move; **completes Phase 4 modal extraction**. `perUnitCost` (crypto total/shares),
  the save payload (incl. the `costCurrency`-persist-only-when-differs rule), and `diffChanges` are
  byte-identical (verbatim), pinned by a before/after render probe (Add/US + Add/crypto-ZAR + Edit-diff +
  no-op) with an **identical result digest**. `MarketPicker` is a multi-caller shared with `WatchlistView`
  (stays in app.js, bridged); `DATA` read at render time; every module dep was already IIFE-read. The
  add/update persistence stays in the `addPosition`/`updatePosition` mutators (data layer).

- **inc-23** `HeatmapView` (~260 lines) + its single-caller `HeatmapFullscreen` (~19 lines) -> `pb-views.js`;
  **+1 bridge (`HeatmapTreemap`) / +5 IIFE reads** (`convertCcy`/`positionCostCcy`/`marketCurrency`/`priceKey`
  from PBCore, `fetchQuoteBatchLight` from PBData — the first PBCore/PBData `const` binds in the views bucket;
  `useLayoutEffect` also added). First **non-modal view** move. Display + delegate: the only money is the
  treemap tile-sizing `convertCcy(shares*costBasis, …)` (pb-core, unmoved), pinned by a before/after render
  probe with an **identical digest**. `HeatmapTreemap`/`ZoomPanHeatmap` + the sector-trend infra stay in
  app.js (bridged); `SectorDetailModal` is read from `PBModals` at render time (pb-modals loads after us).

- **inc-24** `DashboardView` (~299 lines) + its single-caller growth-chart cluster (`CHART_MONTHS`/
  `chartDayLabel`/`buildTimeAxisTicks`/`PortfolioLineChart`, ~406 lines) -> `pb-views.js`; **+2 bridge
  (`PortfolioPieChart` — shared with `TFSAView` — and `fmtNum` — 14 callers) / +5 IIFE reads**
  (`CURRENCY_SYMBOLS` from PBContent, `MARKET_CURRENCY`/`contribInDisplay`/`quoteTradedToday` from PBCore,
  `fetchHistory` from PBData). Display + delegate: the overall-profit/growth aggregation formats pb-core
  helpers (unmoved), pinned by a before/after render probe with an **identical digest**. The two contribution
  modals read from `PBModals` at render time; the cluster is bucket-private (no lead read). The
  `portfolio-fill.test.mjs` delegation guard followed `PBCore.forwardFillPortfolio(` into the bucket
  (now spans app.js + pb-views.js).

- **inc-25** `CurrentView` (~207 lines, the Holdings tab) -> `pb-views.js`; **+2 bridge
  (`HoldingRow`/`HoldingsListHead` — multi-callers shared with `TFSAView`, so they stay in app.js and are
  bridged, the inc-22 `MarketPicker` precedent) / +2 IIFE reads (`MARKETS` from PBContent,
  `valuePositionInCostCcy` from PBCore)**. Display + per-market aggregation: `computeMarketSummary`/
  `renderSummary` format pb-core helpers (`convertCcy`/`positionCostCcy`/`valuePositionInCostCcy`, unmoved);
  buy/sell/edit/import are props (data layer). Byte-identical (verbatim), pinned by a **source-identity
  proof** (vs `HEAD:app.js`) + a render probe (US same-ccy + crypto-in-ZAR cost-ccy, `marketFilter` US &
  CRYPTO). `content.test.mjs` untouched — `MARKETS` stays a bind in app.js (not the inline array). Lays the
  two row bridges the later `TFSAView` move reuses.

**Current state:** `pb-modals.js` holds **11 modals + the detail subtree + the settings subtree**;
`window.PBApp` bridge = **43** members (33 after feature PRs #27–#29; inc-19 added 4, inc-22 added 1, inc-23 added 1, inc-24 added 2, inc-25 added 2);
`sw.js` `CACHE_NAME` = **playbook-shell-v75**. **Phase 4 modal extraction is COMPLETE** — every modal
(and all three money modals) lives in the bucket. `pb-views.js` now holds **9 views + the Heatmap fullscreen chrome + the growth-chart cluster** — inc-23 (`HeatmapView`) + inc-24 (`DashboardView`) + inc-25 (`CurrentView`) opened and advanced the **non-modal view tier**.

## Remaining modals — prioritized (senior-dev, no-regression first)

Re-verified by reading each modal body — the split is **display/delegate (safe verbatim move)** vs
**contains money/alert math (characterization test first)**:

**DONE — inc-18: `AlertsModal`** — SAFE verbatim move completed. As predicted: 0 new bridge members,
0 new IIFE reads (`openChart` confirmed a local closure; all deps already bridged/IIFE-read). Mount
gate + a dedicated render probe (active alerts + triggered history + note branch + perm box) green.

**DONE — inc-19: `ImportModal`** (~612 lines) — SAFE display + delegate move completed. +4 bridge
(`TickerSearch` multi-caller; the impure readers `parseImportFile`/`ocrImageFile`/`searchListingsMulti`
kept in app.js — each roots a stays-put app.js infra cluster) / +7 `PBImport` IIFE reads (the
matchers). `DATA` read at render time. No inline matching/money logic — confirmed rows are delegated to
`onImport` (the mutator is data-layer). Mount gate + a render probe (input stage; paste -> 2 matched
review cards; DATA sector field; TickerSearch subtree; no import fired) green.

**DONE — inc-20: `BuyModal`** (~92 lines) — first money-tier move; the rule-#3 pin (avg re-blend +
`onBuy` payload, US + crypto-in-ZAR) was green **before & after** the verbatim move. +1 IIFE read
(`positionCostCcy`), 0 new bridge.

**DONE — inc-21: `SellModal`** (~138 lines) — the %<->shares sync (both directions + chip), `pnl =
(price - costBasis) * shares` (sign + format), the validity cap, and the 6-arg `onSell` payload (no
costCcy) were pinned by a before/after render probe (sell + loss + over-holding), green both sides.
**0 new bridge / 0 new IIFE reads** — verbatim. Realized gain/proceeds stay in the `onSell` mutator.

**DONE — inc-22: `PositionModal`** (~326 lines) — the last money modal. Built the cost-basis save payload
(cost mode / currency / crypto total-vs-per-unit -> `perUnitCost`) + `diffChanges`; pinned by a
before/after render probe (identical digest) and moved verbatim. **+1 bridge (`MarketPicker`, the shared
multi-caller with `WatchlistView`) / +0 IIFE reads**; `DATA` read at render time; `SectorWeightRows`
already bridged. **Phase 4 modal extraction is now COMPLETE.**

**NEXT -> the non-modal view tier is underway.** inc-23 extracted `HeatmapView`; inc-24 extracted `DashboardView` (+ its `PortfolioLineChart` growth-chart cluster); inc-25 extracted `CurrentView` (the Holdings tab — `HoldingRow`/`HoldingsListHead` bridged, shared with TFSA). **Remaining tab views: `WatchlistView`, `TFSAView`** (WatchlistView ~1035 lines, delegate-only with `MarketPicker`/`TickerSearch` already bridged; TFSA carries R46k/R500k limit math -> characterization test first, and once it moves the two shared rows lose their last app.js caller and relocate into the bucket — a bridge shrink). Every modal (and all three money modals) is already in the
bucket. Remaining Phase-4 candidates, if the refactor continues, are non-modal: the large remaining
app.js view/section components (and the vestigial `FxSummary` dead-code cleanup below). Otherwise the
post-refactor plan is `SECURITY_ROADMAP.md` (do not start before the refactor phases are called done).

**Roadmap correction (2026-07-14, confirmed 2026-07-18):** an earlier version of this file lumped
`AlertsModal` into the rule-#3-gated tier. On re-reading, Alerts is display + CRUD only (no eval, no
money) -> a safe move. Borne out by inc-18 (Alerts) and inc-19 (Import): both were safe verbatim
moves. The safe verbatim-move tier was exhausted after Import; the money tier — Buy (inc-20), Sell
(inc-21), Position (inc-22) — is now **also complete**, each pinned by a characterization test first.

## The mechanical recipe (turnkey — every increment 15–17 followed this)

1. **Exhaustive dependency inventory** of the move block: extract to scratchpad, enumerate every free
   identifier, classify each — already-in-IIFE / already-bridged / **new bridge** (app.js internal
   with callers *outside* the block) / **new IIFE read** (`PBxxx.X` module global) / native / prop /
   **subtree-local** (single-caller -> moves with the block). `PBStore.*` is a free global (no bridge).
2. **Verbatim move via a Node slice script — NEVER the Edit tool** (files are **BOM + LF**; bodies
   carry literal `£ € · – — " '`). Read/write `utf8`, split/join `\n`, keep the BOM, splice with a
   **replacement function** (avoids `$'`/`$&` expansion).
3. **Inject a minimal render-time lead read** per moved component: `const { …only-what-it-uses… } =
   window.PBApp;` as the first body statement (for a multi-line signature, after the params `) {`).
4. **Grow/shrink the bridge** publish line (`window.PBApp = { … }`, end of app.js) — all members
   defined before it (TDZ-safe). Add new **IIFE reads** near the top of `pb-modals.js`. Register
   `window.PBModals.<Modal>`; replace the app.js def with a pointer comment + `const X =
   PBModals.X;`.
5. **Wiring:** bump `sw.js` `CACHE_NAME` (only shipped-file change — bucket already wired; the
   `deploy-assets` suite guards index/sw/static consistency). **If a `PBContent` bind moves out of
   app.js** (single-caller like inc-16's `SECTOR_FWD_PE`), update the `content.test.mjs` delegation
   guard to check `appSrc + modSrc` (preserve the anti-inline invariant; don't weaken).
6. **Docs:** `architecture-map.html` bridge count + member list.
7. **Verify (all green before commit):** `node --check`; full node suite (**money gate** +
   **content guard** + **deploy-assets**); anti-drift greps (`function <Modal>` = 0 app.js / 1 bucket;
   moved-out helpers gone / stayed helpers still once; bridge membership); **mount gate**
   `verify-refresh-behavior`; a **throwaway render probe** that opens the modal and asserts it +
   subtree render (never trigger destructive/money side-effects); U+FFFD scan.
8. Spec + plan under `docs/superpowers/`; append a measured read-out to the spec. Commit + push to the
   feature branch. **No PR, never `main`.** Update this file's Done/Current-state.

## Environment notes (remote Linux container)

- Browser harnesses assume Windows Chrome + unpkg. Run them from **scratchpad copies** patched to:
  pin `ROOT=/home/user/Playbook`, serve a locally `npm i`'d React (unpkg is 403-blocked;
  `registry.npmjs.org` is in the proxy `noProxy`) via `/__react.js` + `/__react-dom.js` routes, and
  add `--no-sandbox`. `CHROME_PATH=/opt/pw-browsers/chromium`. **Do not modify committed harnesses.**
  A ready patcher + probe scaffold live in the session scratchpad (`patch-harness.mjs`,
  `probe-*.mjs`) — re-createable from the recipe.
- `verify-modals` / screenshot harnesses have a **pre-existing flaky CDP "Execution context
  destroyed" race** — rerun before blaming a change. Screenshot writes to `test-screenshots/` are
  incidental; `git checkout -- test-screenshots/` before committing.

## Observations / cleanup candidates (out of scope for the moves)

- **`FxSummary`** (`app.js`, ~9736 pre-inc-17) has **no callers** — vestigial dead code. Flag for a
  separate cleanup; left untouched by inc-17.
