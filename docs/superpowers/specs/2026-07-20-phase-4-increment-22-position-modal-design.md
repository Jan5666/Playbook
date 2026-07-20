# Phase 4 increment 22 — last money modal: `PositionModal` -> `pb-modals.js`

**Date:** 2026-07-20
**Branch:** `claude/refactor-plan-continuation-szkz3n` (off latest `origin/main` @ inc-21/PR #32)
**Status:** executed — all gates green (see measured read-out)

## Goal

Move the add/edit-position sheet `PositionModal` (`app.js`, **326 lines**) into the `pb-modals.js`
bucket as a **byte-identical verbatim move**. Third and final modal of the rule-#3-gated money tier
(after inc-20 `BuyModal`, inc-21 `SellModal`) — a **characterization test pinning current behavior
comes first**, then the verbatim relocation. This **completes Phase 4 modal extraction**: the bucket
holds every modal.

## The money behavior being moved (what rule #3 protects)

- **Per-unit cost derivation:** `perUnitCost = (isCrypto && costMode === 'total') ? totalSpent/shares :
  parseDecimal(costBasis)` — crypto "Total spent" mode divides the total by the amount so the holder can
  type what they actually paid; every other case is a direct per-share price.
- **Save payload (`submit`):** `{ ticker, market, shares, costBasis: perUnitCost, notes, purchaseDate,
  sector, sectorWeights, costCurrency }` — where **`costCurrency` is persisted only when it genuinely
  differs from the market's native currency** (`(isCrypto && costCcyCode !== marketCurrency(market)) ?
  costCcyCode : undefined`), so a normal USD/native holding stays untouched and a crypto-in-ZAR holding
  records ZAR. Handed up via `onSave(payload, verifiedQuote)`; the add/update itself runs in the
  `addPosition`/`updatePosition` mutators (data layer), **not** the modal.
- **Edit diff (`diffChanges`):** for an edit, lists exactly which fields changed (old -> new) — including
  the avg-price row prefixed with the `positionCostCcy`-derived currency symbol and the sector-split row
  — so an accidental edit can't slip through the confirm portal. No money is computed here beyond
  formatting; the values are compared, not re-derived.
- **Live-feed verify:** a **new** position (or an edit that changed the ticker/market) awaits
  `fetchQuote` before saving; a pure shares/cost/date edit stays **offline** (no fetch).

## Dependency inventory (every free identifier classified)

After subtracting locals / natives / props / already-bridged / already-IIFE-read, the residue is a
single bridge add. **+1 bridge (37 -> 38), +0 IIFE.**

### Reaches app.js internals -> bridge (`window.PBApp`) — **+1 (37 -> 38)**

- **`MarketPicker`** — the one new member. A **multi-caller** (`PositionModal` **and** `WatchlistView`
  at `app.js:7083`), so it **stays in app.js** and is published on the bridge; it's a self-contained
  component (hooks + `MARKETS` + `document`) that runs in app.js closure scope.
- Already bridged: `Icon`, `useSwipeDownToClose`, `useBodyScrollLock`, `SectorWeightRows`,
  `TickerSearch` (inc-19), `sanitizeDecimalInput`.

Injected lead read:
`const { Icon, useSwipeDownToClose, useBodyScrollLock, SectorWeightRows, TickerSearch, sanitizeDecimalInput, MarketPicker } = window.PBApp;`

### Reads module globals -> IIFE — **+0**

Every PB* global it uses was **already** read at the top of `pb-modals.js` by inc-11..21:
`parseDecimal`, `CURRENCY_SYMBOLS`, `marketCurrency`, `positionCostCcy`, `fetchQuote`,
`MARKET_CURRENCY`, `DISPLAY_CURRENCIES`, plus `useState`/`useRef`. `React`/`ReactDOM` are UMD globals
(the edit-confirm portal uses `ReactDOM.createPortal`, already used in the bucket).

### `DATA` read at render time

`DATA.findSector` / `DATA.SECTOR_CANON` — injected `const DATA = window.PB_DATA;` in-body (data.js loads
after the bucket; the ImportModal/pb-views pattern).

### `content.test.mjs` unaffected

No `PBContent` bind moves out of app.js; the delegation guard passes with **no test change**.

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; the body carries literal `£ € · – —`, `≈`,
`…`). Block = `function PositionModal(_ref12) {` (app.js:8586) through the `}` (8911) immediately before
the inc-21 `// SellModal moved to pb-modals.js (Phase 4 inc-21).` pointer. Markers + a coarse brace
balance validated in memory before any write.

Into `pb-modals.js` (before the registration block; hoisting makes order moot):
- **1 render-time lead read** + **1 `DATA` render-time read** injected after the single-line signature.
- Register `window.PBModals.PositionModal = PositionModal;` after the `SellModal` registration.

In `app.js`: block -> pointer comment + `const PositionModal = PBModals.PositionModal;`. **Add
`MarketPicker`** to the bridge publish line (defined at 5962, before the publish line — TDZ-safe). The
invocation site (`app.js:3621`, `posModalOpen && …`) is untouched.

## Wiring

- `sw.js` `CACHE_NAME` **v71 -> v72**. Only shipped-file wiring.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the harnesses — bucket already wired.
- `architecture-map.html` — bridge **37 -> 38** (+`MarketPicker`), inc-22 history note.
- `REFACTOR_STATUS.md` — Done + Current-state (**11 modals, bridge 38, v72**; **Phase 4 modal
  extraction COMPLETE**).

## Verification gate

1. `node --check` app.js + pb-modals.js + sw.js.
2. Full node suite (**27**; money gate unaffected — no pb-core/pb-import money code moved; content guard;
   deploy-assets).
3. Anti-drift greps: `function PositionModal` = 0 app.js / 1 pb-modals.js; pointer + bind; registration;
   lead read; **bridge = 38** with `MarketPicker`; `function MarketPicker` still 1 in app.js (stays put).
4. **Verbatim proof:** brace-matched moved body == `HEAD:app.js` aside from the injected lead read + DATA.
5. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED**.
6. **Position characterization render probe** (throwaway, **before & after**): render `PositionModal` in
   an isolated `#probe` root; mock `fetch` so `fetchQuote` resolves; spy `onSave`/`onClose`. Pin: **A**
   Add/US payload (`costBasis:150`, `costCurrency:undefined`, `sectorWeights:null`, `purchaseDate:today`);
   **B** Add/crypto-ZAR "Total spent" (`perUnitCost=20000` shown in the per-coin hint; `costBasis:20000`,
   `costCurrency:'ZAR'`); **C** Edit/no-listing-change (`diffChanges` Shares 10->12 in the confirm portal;
   confirm fires `onSave(payload, null)` — offline, no verified quote); **D** no-op edit -> `onClose`, no
   `onSave`. U+FFFD scan.

## Out of scope / deferred

- The add/update persistence (`addPosition`/`updatePosition`) + realized-value/FX math live in the data
  layer (via `onSave`) — not moved.
- **`FxSummary`** (`app.js`) remains vestigial dead code — flagged for a separate cleanup, untouched here.

## Commit note

Development on `claude/refactor-plan-continuation-szkz3n`; commit + push to the feature branch.
**No PR; `main` never pushed.** Scratchpad scripts never committed.

## Measured read-out (2026-07-20, on execution)

All gates green — the prediction held exactly.
- **Rule-#3 pin green before AND after** the move. Baseline (`PositionModal source: app.js-global`) and
  post-move (`PositionModal source: PBModals`) probes both **ALL PASSED** with a **byte-identical result
  digest**: **A** `{ticker:'AAPL', market:'US', shares:10, costBasis:150, notes:'', purchaseDate:today,
  sector:'Technology', sectorWeights:null, costCurrency:undefined}`; **B** per-coin hint `≈ R20,000 per
  coin`, `{...costBasis:20000, costCurrency:'ZAR', market:'CRYPTO', shares:0.5}`; **C** diff
  `[Shares 10->12, Sector Other->Technology]`, confirm -> `onSave(shares:12, costBasis:150, quote=null)`;
  **D** `{saves:0, closes:1}`. The probe source flipped app.js-global -> PBModals and the bridge gained
  `MarketPicker`, proving the move while behavior stayed identical.
- **Verbatim:** brace-matched moved body **byte-identical to `HEAD:app.js`** (326 lines each) aside from
  the injected lead read + `DATA` line.
- `node --check` OK (app.js, pb-modals.js, sw.js). Full node suite **27/27** (money gate + content guard
  + deploy-assets). U+FFFD = 0; BOM + LF preserved; no CRLF.
- Anti-drift: `function PositionModal` **0 app.js / 1 pb-modals.js**; pointer + `const PositionModal =
  PBModals.PositionModal` at the old def site; registration after `SellModal`; **bridge 38** with
  `MarketPicker`; `function MarketPicker` **1 in app.js** (unmoved, still bridged).
- Mount gate `verify-refresh-behavior` **ALL PASSED**.

**Bucketing economics, measured:**
- `app.js` **-319 net** (326-line block -> 7-line pointer + bind), `pb-modals.js` **+329** (326-line block
  + 2 injected reads + 1 registration + blank), `sw.js` **v71 -> v72**. Zero index/static/harness edits.
- **Bridge 37 -> 38 (+MarketPicker), IIFE +0.** The last modal needed only the one shared multi-caller;
  every money/module dependency was already wired by inc-11..21.
- **Rule #3 honored:** `perUnitCost`, the `costCurrency`-persist rule, and `diffChanges` are pinned by a
  before/after probe and left byte-identical; the persistence + FX math were never in the modal.

**Conclusion:** the add/edit-position sheet is extracted; **Phase 4 modal extraction is COMPLETE** — the
bucket holds **11 modals + the detail subtree + the settings subtree**; bridge **38**; `sw` `CACHE_NAME`
**v72**. All three money modals (Buy/Sell/Position) are done.
