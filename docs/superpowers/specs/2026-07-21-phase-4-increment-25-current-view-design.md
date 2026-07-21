# Phase 4 increment 25 — the Holdings tab: `CurrentView` -> `pb-views.js`

**Date:** 2026-07-21
**Branch:** `claude/refactor-plan-continuation-yywg24` (off latest `origin/main` @ inc-24/PR #34)
**Status:** executed — all gates green (see measured read-out)

## Goal

Move the Holdings tab view `CurrentView` (`app.js`, **207 lines**, 4582–4788) into `pb-views.js` as a
**byte-identical verbatim move**. Third non-modal view increment (after inc-23 `HeatmapView`, inc-24
`DashboardView`). Display + per-market aggregation: every mutator is a prop
(`onAddPosition`/`onEditPosition`/`onBuyPosition`/`onSellPosition`/`onImportPositions`) wired to the data
layer; the shared row components `HoldingRow`/`HoldingsListHead` **stay in app.js** (still used by
`TFSAView`) and are bridged. This also lays the two row bridges that the later `TFSAView` move reuses.

## Why this is a display move (not money-tier)

`CurrentView` **displays** aggregates. `computeMarketSummary` sums `p.shares * q.price` and books cost via
`convertCcy(p.shares*p.costBasis, positionCostCcy(p), native, rates)` — `convertCcy`/`positionCostCcy` are
**pb-core functions that stay in pb-core**; the per-row value comes from `valuePositionInCostCcy` (also
pb-core). `renderSummary` is presentation arithmetic (invested/delta bar widths, today line). No
cost-basis is re-derived, no order placed, no `pb.*` key written — the buy/sell/edit/import actions are
props. So the pin is a **render probe** (a US same-ccy market + the crypto-in-ZAR cost-ccy path), plus a
**source-identity proof** that the moved body is byte-identical to HEAD — not a new characterization test.
Only `TFSAView` (R46k/R500k + contribution-room math) is money-tier among the remaining views.

## Dependency inventory (every free identifier classified)

Move block = `CurrentView` (4582–4788). Its internal helpers (`sortRows`, `computeMarketSummary`,
`renderSummary`, `renderActions`, `renderMarket`, `tabLabel`, `BASE_TABS`, `sortOptions`) are body-local
and move with it — no subtree extraction. Exhaustive residue analysis yields **+2 bridge, +2 IIFE reads**
— lean, because inc-24 already bridged the dashboard's formatters that CurrentView shares.

### Reaches app.js internals -> bridge (`window.PBApp`) — **+2 (41 -> 43)**

- **`HoldingRow`** and **`HoldingsListHead`** — **multi-callers**: used by `CurrentView` **and** `TFSAView`
  (`app.js:7544`/`7546`). Since `TFSAView` stays in app.js this increment, both **stay in app.js** and are
  bridged (the inc-22 `MarketPicker` precedent). They keep their own app.js bindings unchanged.
- Already bridged (from inc-24): `Icon`, `fmtCcy`, `fmtCcySigned`, `MARKET_LABELS`, `positionDisplayName`.

Injected `CurrentView` lead read:
`const { HoldingRow, HoldingsListHead, Icon, fmtCcy, fmtCcySigned, MARKET_LABELS, positionDisplayName } = window.PBApp;`

### Reads module globals -> IIFE — **+2**

`MARKETS` (PBContent) and `valuePositionInCostCcy` (PBCore) — the first views-bucket reads of each, added
at the top of the bucket IIFE. `priceKey`/`convertCcy`/`positionCostCcy`/`marketCurrency` (inc-23) and
`quoteTradedToday` (inc-24) were already IIFE-read; `useState` is in the IIFE hook block; `PBStore.*`
hooks are inline global reads. `app.js` **keeps its own parallel binds** (`app.js:444` MARKETS, `app.js:1316`
valuePositionInCostCcy — the latter still used by the staying `HoldingRow`), per the inc-24
`CURRENCY_SYMBOLS` precedent (keep the app.js bind, add a parallel IIFE read).

### `content.test.mjs` guard — untouched (no source-guard follow)

No PBContent/PBCore bind **moves out** of app.js: `MARKETS` stays bound at `app.js:444`, so the guard's
`!appSrc.includes('const MARKETS = [')` (forbids the inline array) still holds. Adding a parallel
`const MARKETS = PBContent.MARKETS;` in the bucket is a *bind*, not the inline literal — guard passes
unchanged. (Contrast inc-16/inc-24, where a bind moved out and the guard had to span both files.)

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; the body carries literal `£ · — − " '`).
One atomic script validated the block in memory against content anchors (`function CurrentView(_ref7) {`
open, first top-level `}` close, exactly one `} = _ref7;` for the lead-read injection point) before
writing both files.

Into `pb-views.js` (before the registration block; hoisting makes order moot): `CurrentView` with its lead
read; register `window.PBViews.CurrentView = CurrentView;` after the `DashboardView` registration.

In `app.js`: the `CurrentView` span -> a pointer comment + `const CurrentView = PBViews.CurrentView;`
(TDZ-safe; the App tab-switch call site at `app.js:3438` is inside a function body). **Add `HoldingRow,
HoldingsListHead`** to the bridge publish line (both defined at 4506/4512, before it).

## Wiring

- `sw.js` `CACHE_NAME` **v74 -> v75**. Only shipped-file wiring.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the harnesses — the bucket is already wired.
- `architecture-map.html` — bridge **41 -> 43** (+`HoldingRow`, +`HoldingsListHead`) in the count/narrative
  and the literal member list, plus an inc-25 history note.
- `REFACTOR_STATUS.md` — Done + Current-state (bridge **43**, `sw` **v75**, `pb-views.js` **9 views**).
- No test-guard update (no bind moved out of app.js).

## Verification gate

1. `node --check` app.js + pb-views.js.
2. Full node suite (**27**; money gate unaffected; content guard; deploy-assets; portfolio-fill).
3. Anti-drift greps: `function CurrentView` = 0 app.js / 1 pb-views.js; `HoldingRow`/`HoldingsListHead`
   defs still 1 in app.js (stay); pointer + bind; registration; **bridge = 43**.
4. **Verbatim proof:** the `CurrentView` body (minus the lead read) is byte-identical to `HEAD:app.js`
   and absent from the new app.js.
5. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED** (it navigates to the current tab and asserts
   `.holding-row` rows render with no session badge — a direct post-move CurrentView exercise).
6. **Render probe:** standalone-mount `PBViews.CurrentView` with a US 2-position fixture (same-ccy
   aggregation) + a crypto-in-ZAR position (cost-ccy `convertCcy` path), for `marketFilter` US and CRYPTO;
   assert the summary + rows + tabs render with the correct figures. U+FFFD scan; BOM/LF integrity.

## Out of scope / deferred

- `HoldingRow`/`HoldingsListHead` stay in app.js (bridged) while `TFSAView` still uses them; once `TFSAView`
  moves they lose their last app.js caller and can relocate into the bucket (bridge shrinks 43 -> 41).
- Remaining tab views: **`WatchlistView`** (~1035 lines, delegate-only) and **`TFSAView`** (money-tier,
  characterization test first).
- **`FxSummary`** (`app.js`) remains vestigial dead code — flagged for a separate cleanup, untouched.

## Commit note

Development on `claude/refactor-plan-continuation-yywg24`; commit + push to the feature branch. **No PR;
`main` never pushed.** Scratchpad scripts never committed.

## Measured read-out (2026-07-21, on execution)

All gates green.
- **Verbatim:** the 207-line `CurrentView` body is byte-identical to `HEAD:app.js` (aside from the one
  injected lead read) and absent from the new app.js. Proven by a `git show HEAD:app.js` vs `pb-views.js`
  line-by-line diff (source-identity), stronger than a stash-based before/after.
- **Render probe green.** US (`marketFilter:'US'`): AAPL `$2,400.00` (+$600.00), GOOGL `$750.00`
  (+$147.50), summary P/L `+$747.50`, tabs `USA/SA/TFSA/Crypto`. CRYPTO (`marketFilter:'CRYPTO'`,
  crypto-in-ZAR): BTC row value `R360,000.00` (+R110,000.00), avg cost `R500,000.00`, summary native
  `$20,000.00` — the `convertCcy`/`positionCostCcy`/`valuePositionInCostCcy` cost-ccy path resolves and
  renders in ZAR. Every moved binding (bridge reads + new IIFE reads) resolved.
- `node --check` OK. Full node suite **27/27** (money gate + content guard + deploy-assets + portfolio-fill,
  all unchanged — no guard update). U+FFFD = 0; BOM + LF preserved; no CRLF.
- Anti-drift: `function CurrentView` **0 app.js / 1 pb-views.js**; `const HoldingRow`/`function
  HoldingsListHead` **1 in app.js** (stay); pointer + `const CurrentView = PBViews.CurrentView`;
  registration after `DashboardView`; **bridge 43** ending `…fmtNum, HoldingRow, HoldingsListHead`.
- Mount gate `verify-refresh-behavior` **ALL PASSED** — the current-tab assertion (`holdRows:2`,
  `holdBadge:null`) confirms post-move CurrentView rows render.

**Bucketing economics, measured:**
- `app.js` **-205 net** (207-line view -> 2-line pointer + bind), `pb-views.js` **+213** (block + lead read
  + 3 IIFE lines + registration), `sw.js` **v74 -> v75**. Zero index/static/harness/test-guard edits.
- **Bridge 41 -> 43 (+HoldingRow, +HoldingsListHead), IIFE +2 (MARKETS, valuePositionInCostCcy).** The
  lean footprint is because inc-24 pre-bridged the shared formatters.

**Conclusion:** the Holdings view is extracted; `pb-views.js` now holds **9 views + the Heatmap fullscreen
chrome + the growth-chart cluster**; bridge **43**; `sw` `CACHE_NAME` **v75**. Remaining tab views:
`WatchlistView`, `TFSAView`.
