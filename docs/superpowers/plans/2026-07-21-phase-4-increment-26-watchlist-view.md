# Phase 4 increment 26 — extract `WatchlistView` — Implementation Plan

**Goal:** Move the 860-line `WatchlistView` (the Watchlist tab, `app.js` 5536–6395) into `pb-views.js`.
Bridge **43 -> 46** (**+`SessionBadge`** — multi-caller shared with `PriceBlock`; **+`useHotStocks`
+`buildSuggestions`** — single-callers that root stays-put app.js infra clusters, so they are bridged, not
moved); **+1 IIFE read** (`parseDecimal` from PBCore). Fourth view-tier move. Display + delegate — CRUD and
the alert-add popup go out through props to the data layer.

**Branch:** `claude/refactor-plan-continuation-0si1yg` (off latest `origin/main` @ inc-25/PR #35).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; body carries literal `£ · — " '`. Replacement-array splice;
  content anchors validated in memory; both files written atomically.
- **Bridge +3 / IIFE +1:** `MarketPicker`/`TickerSearch`/`PriceBlock`/`Icon`/`fmt`/`fmtNum`/
  `sanitizeDecimalInput`/`usePersistedState`/`watchListIds`/`prettyName`/`resolveTickerName` already
  bridged; `priceKey`/`MARKET_CURRENCY` already IIFE-read; `useState`/`useEffect`/`useRef`/`useMemo` in the
  IIFE hook block; `PBStore.usePricesMap` an inline global. Add `parseDecimal` at the bucket top. Add
  `SessionBadge`/`useHotStocks`/`buildSuggestions` to the bridge.
- **Multi-caller / infra-root rule:** `SessionBadge` is used by both `WatchlistView` and the staying
  `PriceBlock` -> stays in app.js, bridged (inc-22 `MarketPicker` precedent). `useHotStocks`/
  `buildSuggestions` are single-caller but each roots an app.js infra cluster (`PBData.fetchHotStocks`/
  `poolMap`/`fetchQuoteLight`; `DATA` render-time-only + `readSearchHist`/`cachedName`) -> stay in app.js,
  bridged (inc-19 impure-reader precedent). `useHotStocks` is a hook called through the bridge like
  `usePersistedState`/`useContainerWidth`.
- Rule #3: no money/alert math moves — the alert popup only validates (`parseDecimal`) then calls
  `onAddAlert`; alert eval + money math stay in pb-core. Pinned by a render probe + a verbatim proof.
- `content.test.mjs` guard is **untouched** — `parseDecimal` stays a bind in app.js; the bucket's parallel
  bind is not a forbidden inline literal.

## Task 1 — move block + lead read + bridge + register + bump sw

Files: `app.js` (WatchlistView span -> pointer + `const WatchlistView = PBViews.WatchlistView`;
**+`SessionBadge, useHotStocks, buildSuggestions`** on the bridge line), `pb-views.js` (1 IIFE bind;
WatchlistView with lead read; WatchlistView registration after `CurrentView`), `sw.js` (v75 -> v76).
Throwaway scratchpad surgery script. `node --check` both.

## Task 2 — docs

`architecture-map.html`: bridge **43 -> 46** + member list + inc-26 note. `REFACTOR_STATUS.md`
Done/Current-state (bridge **46**, `sw` **v76**, `pb-views.js` **10 views**). Spec + this plan under
`docs/superpowers/`. No source-guard update (no bind moved out of app.js).

## Task 3 — verify

Node suite (money gate + content guard + deploy-assets + portfolio-fill, all unchanged) green; anti-drift
greps (`function WatchlistView` 0/1; `SessionBadge`/`useHotStocks`/`buildSuggestions` still 1 in app.js;
pointer + bind; registration; **bridge 46**); **verbatim proof** (WatchlistView body an exact match of
`HEAD:app.js` aside from the lead read, absent from app.js); mount gate `verify-refresh-behavior`
ALL PASSED; **render probe** (standalone-mount the app, navigate to the Watchlist tab with a seeded
watchlist + position + alert — cards, add-form/`TickerSearch` input, and alert popup render); U+FFFD +
BOM/LF integrity.

## Task 4 — read-out + progress doc + commit

Append the measured read-out to the spec. Refresh `REFACTOR_STATUS.md`. Commit to the feature branch.
**No PR; never `main`.**

## Self-review

- No money/alert math moves -> pinned by a render probe (Watchlist tab with a seeded alert) and a
  source-identity verbatim proof; the alert popup delegates to `onAddAlert`, eval/money stay in pb-core.
- Inventory complete via exhaustive residue analysis (+3 bridge / +1 IIFE) -> anti-drift greps + verbatim
  diff. The three bridge members are all stays-put app.js code; only the view shell moved.
- Load order: the bridge publish + IIFE bind are TDZ-safe (render-time reads); `DATA` is never read at
  bucket load time (it lives inside the still-in-app.js `buildSuggestions`).
- Encoding (`£ · —`) -> U+FFFD scan + BOM/LF preserved + verbatim diff.
- `SessionBadge` bridged (not moved) while `PriceBlock` still calls it; `useHotStocks`/`buildSuggestions`
  bridged to avoid dragging their app.js infra clusters into the bucket. Rule #4 unaffected (no change to
  `HoldingRow`).
