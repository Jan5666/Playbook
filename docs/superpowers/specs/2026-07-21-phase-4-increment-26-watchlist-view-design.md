# Phase 4 increment 26 — the Watchlist tab: `WatchlistView` -> `pb-views.js`

**Date:** 2026-07-21
**Branch:** `claude/refactor-plan-continuation-0si1yg` (off latest `origin/main` @ inc-25/PR #35)
**Status:** executed — all gates green (see measured read-out)

## Goal

Move the Watchlist tab view `WatchlistView` (`app.js`, **860 lines**, 5536–6395) into `pb-views.js` as a
**byte-identical verbatim move**. Fourth non-modal view increment (after inc-23 `HeatmapView`, inc-24
`DashboardView`, inc-25 `CurrentView`). Display + delegate: every mutator is a prop
(`onAdd`/`onRemove`/`onReorder`/`onMoveWatch`/`onAdd|Rename|RemoveWatchGroup`/`onOpenDetail`/`onAddAlert`/
`onRemoveAlert`) wired to the data layer; the alert-add popup only *builds* an alert then calls `onAddAlert`.

## Why this is a display move (not money-tier)

`WatchlistView` **displays** watched symbols and **delegates** every state change through props. The only
numeric logic in its body is presentation: reading a live quote off `PBStore.usePricesMap()` for the card
%, and `parseDecimal(alertTarget)` to validate the alert-popup input before handing a value to `onAddAlert`
(the alert is stored by the data-layer mutator; **no alert eval, no money math** lives here — that stays in
pb-core). No cost-basis is derived, no order placed, no `pb.*` key written directly. So the pin is a
**render probe** (mount the Watchlist tab with a seeded watchlist + position + alert, assert the cards, the
add-form/`TickerSearch` subtree, and the alert popup render) plus a **source-identity proof** that the moved
body is byte-identical to HEAD — not a new characterization test. Only `TFSAView` (R46k/R500k +
contribution-room math) remains money-tier among the views.

## Dependency inventory (every free identifier classified)

Move block = `WatchlistView` (5536–6395). Exhaustive residue analysis (all top-level identifiers used in the
block, minus already-bridged / already-IIFE-read / native / props) yields **+3 bridge, +1 IIFE read**.

### Reaches app.js internals -> bridge (`window.PBApp`) — **+3 (43 -> 46)**

- **`SessionBadge`** (`app.js:3858`, `React.memo`) — **multi-caller**: also rendered inside `PriceBlock`
  (`app.js:3957`), which stays in app.js. So `SessionBadge` **stays in app.js** and is bridged (the inc-22
  `MarketPicker` / inc-25 `HoldingRow` precedent). *Rule #4 is unaffected* — bridging the component does not
  re-add it to `HoldingRow`.
- **`useHotStocks`** (`app.js:5404`, hook) and **`buildSuggestions`** (`app.js:5442`, pure builder) —
  **single-caller** (only `WatchlistView`, at 5950–5951), but each **roots a stays-put app.js infra
  cluster**: `useHotStocks` -> `PBData.fetchHotStocks`/`poolMap`/`fetchQuoteLight`; `buildSuggestions` ->
  `DATA` (which the bucket only reads at **render time**, not at load), `readSearchHist`, `cachedName`.
  Rather than drag those clusters (and a load-time `DATA` binding problem) into the bucket, they **stay in
  app.js** and are bridged — the inc-19 impure-reader precedent (`parseImportFile`/`ocrImageFile`/
  `searchListingsMulti` kept put). `useHotStocks` is called through the bridge like the already-bridged
  hooks `usePersistedState`/`useContainerWidth`.
- Already bridged: `MarketPicker`, `TickerSearch`, `PriceBlock`, `Icon`, `fmt`, `fmtNum`,
  `sanitizeDecimalInput`, `usePersistedState`, `watchListIds`, `prettyName`, `resolveTickerName`.

Injected `WatchlistView` lead read:
`const { SessionBadge, MarketPicker, TickerSearch, PriceBlock, Icon, fmt, fmtNum, sanitizeDecimalInput, usePersistedState, watchListIds, prettyName, resolveTickerName, useHotStocks, buildSuggestions } = window.PBApp;`

### Reads module globals -> IIFE — **+1**

`parseDecimal` (PBCore) — the first views-bucket read of it, added at the top of the bucket IIFE.
`priceKey`/`MARKET_CURRENCY` (inc-23/24) were already IIFE-read; `PBStore.usePricesMap` is an inline global
read; the hooks `useState`/`useEffect`/`useRef`/`useMemo` are in the IIFE hook block. `app.js` keeps its own
`const parseDecimal = PBCore.parseDecimal;` bind (`app.js:517`, still used by the staying helpers), per the
inc-24 `CURRENCY_SYMBOLS` precedent (keep the app.js bind, add a parallel IIFE read).

### `content.test.mjs` guard — untouched

No PBContent/PBCore bind **moves out** of app.js (`parseDecimal` stays bound at `app.js:517`); the parallel
bucket bind is not an inline literal, so the guard passes unchanged.

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; the body carries literal `£ · — " '`). One atomic
script validated the block in memory against content anchors (`function WatchlistView(_ref8) {` open, first
top-level `}` close, exactly one `} = _ref8;` for the lead-read injection point) before writing both files.

Into `pb-views.js` (before the registration block; hoisting makes order moot): `WatchlistView` with its lead
read; register `window.PBViews.WatchlistView = WatchlistView;` after the `CurrentView` registration.

In `app.js`: the `WatchlistView` span -> a pointer comment + `const WatchlistView = PBViews.WatchlistView;`
(TDZ-safe; the App tab-switch call site at `app.js:3456` is inside a function body). **Add `SessionBadge,
useHotStocks, buildSuggestions`** to the bridge publish line (all defined before it — 3858/5404/5442).

## Wiring

- `sw.js` `CACHE_NAME` **v75 -> v76**. Only shipped-file wiring.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the harnesses — the bucket is already wired.
- `architecture-map.html` — bridge **43 -> 46** in the count/narrative and the literal member list, plus an
  inc-26 history note.
- `REFACTOR_STATUS.md` — Done + Current-state (bridge **46**, `sw` **v76**, `pb-views.js` **10 views**).
- No test-guard update (no bind moved out of app.js).

## Verification gate

1. `node --check` app.js + pb-views.js.
2. Full node suite (**27**; money gate unaffected; content guard; deploy-assets; portfolio-fill).
3. Anti-drift greps: `function WatchlistView` = 0 app.js / 1 pb-views.js; `SessionBadge`/`useHotStocks`/
   `buildSuggestions` defs still 1 in app.js (stay); pointer + bind; registration; **bridge = 46**.
4. **Verbatim proof:** the `WatchlistView` body (minus the lead read) is byte-identical to `HEAD:app.js`.
5. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED** (full app boot with the new bucket layout).
6. **Render probe:** standalone-mount the app, navigate to the Watchlist tab with a seeded watchlist
   (MSFT/NVDA) + a position + an alert; assert the cards render, the add-form/`TickerSearch` input renders,
   and the alert popup opens — without firing add/remove/alert side-effects. U+FFFD scan; BOM/LF integrity.

## Out of scope / deferred

- `SessionBadge`/`useHotStocks`/`buildSuggestions` stay in app.js (bridged) — `SessionBadge` still used by
  `PriceBlock`; the two helpers root app.js infra clusters.
- Remaining tab view: **`TFSAView`** (money-tier — R46k/R500k + contribution-room; characterization test
  first). Once it moves, `HoldingRow`/`HoldingsListHead` lose their last app.js caller and relocate into the
  bucket (a bridge shrink).
- **`FxSummary`** (`app.js`) remains vestigial dead code — flagged for a separate cleanup, untouched.

## Commit note

Development on `claude/refactor-plan-continuation-0si1yg`; commit + push to the feature branch. **No PR;
`main` never pushed.** Scratchpad scripts never committed.

## Measured read-out (2026-07-21, on execution)

All gates green.
- **Verbatim:** the 860-line `WatchlistView` body is byte-identical to `HEAD:app.js` (aside from the one
  injected lead read) and absent from the new app.js. `app.js` **-862 net** (view -> 2-line pointer + bind),
  `pb-views.js` **+865** (block + lead read + 2 IIFE lines + registration), `sw.js` **v75 -> v76**. Zero
  index/static/harness/test-guard edits.
- **Render probe green.** Watchlist tab mounts from the bucket: MSFT + NVDA cards render, the add-form search
  input renders, the alert popup opens (above/below target UI). `useHotStocks`/`buildSuggestions` execute
  during render (the suggestions memo) through the bridge with no error; `SessionBadge` and `parseDecimal`
  resolve. No page exception.
- `node --check` OK. Full node suite **27/27** (money gate + content guard + deploy-assets + portfolio-fill,
  all unchanged — no guard update). U+FFFD = 0; BOM + LF preserved; no CRLF.
- Anti-drift: `function WatchlistView` **0 app.js / 1 pb-views.js**; `const SessionBadge`/`function
  useHotStocks`/`function buildSuggestions` **1 in app.js** (stay); pointer + `const WatchlistView =
  PBViews.WatchlistView`; registration after `CurrentView`; **bridge 46** ending `…HoldingRow,
  HoldingsListHead, SessionBadge, useHotStocks, buildSuggestions`.
- Mount gate `verify-refresh-behavior` **ALL PASSED** — the full app boots with `WatchlistView` served from
  `pb-views.js`.

**Bucketing economics, measured:**
- **Bridge 43 -> 46 (+SessionBadge, +useHotStocks, +buildSuggestions), IIFE +1 (parseDecimal).** The three
  new bridge members are all stays-put app.js code (a multi-caller component + two infra-cluster roots);
  none of the watchlist/suggestion/hot-stocks logic moved — only the view shell.

**Conclusion:** the Watchlist view is extracted; `pb-views.js` now holds **10 views + the Heatmap fullscreen
chrome + the growth-chart cluster**; bridge **46**; `sw` `CACHE_NAME` **v76**. The sole remaining tab view is
`TFSAView` (money-tier).
