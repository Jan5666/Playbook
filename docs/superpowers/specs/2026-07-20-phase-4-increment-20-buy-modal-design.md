# Phase 4 increment 20 — first money modal: `BuyModal` -> `pb-modals.js`

**Date:** 2026-07-20
**Branch:** `claude/refactor-plan-continuation-0c5cqc` (off latest `origin/main` @ inc-19/PR #31)
**Status:** executed — all gates green (see measured read-out)

## Goal

Move the "buy more of an existing holding" sheet `BuyModal` (`app.js:9050–9145`, **96 lines** =
3-line lead comment + 93-line function) into the `pb-modals.js` bucket as a **byte-identical verbatim
move**. This is the **first modal of the rule-#3-gated money tier** — unlike the inc-18/19 safe moves,
`BuyModal` recomputes the **average cost basis in-body**, so per CLAUDE.md rule #3 a **characterization
test pinning current behavior comes first**, then the verbatim relocation.

## The money behavior being moved (what rule #3 protects)

`BuyModal` is presentational + delegating, but it does compute money for the live preview and the
mutator call:

- **Average re-blend (in-body):**
  `newAvg = (position.shares * position.costBasis + numShares * numPrice) / newTotalShares`,
  `newTotalShares = position.shares + numShares`, `addAmount = numShares * numPrice`.
- **Seeded price (cost-currency aware):** the live quote (market-native ccy) is converted into the
  holding's cost currency for the input's initial value —
  `seededPrice = costCcy === nativeCode ? q.price : convertCcy(q.price, nativeCode, costCcy, rates)`.
- **Buy payload:** `onBuy(position.ticker, position.market, numShares, numPrice, buyDate, notes, costCcy)`
  where `costCcy = positionCostCcy(position)` (native for a normal holding, the booked fiat for
  crypto-in-ZAR).

The **merge / re-average that persists** happens in the `onBuy` mutator (the data layer / `addPosition`),
**not** in this modal — that code is untouched. The modal's job is the preview math + the payload; both
are pinned by the render probe below and left byte-identical by the move.

## Dependency inventory (every free identifier classified)

After subtracting locals / natives / props / already-bridged / already-IIFE-read, the residue is a
**single new IIFE read** — `positionCostCcy`. **Zero new bridge members.**

### Reaches app.js internals -> bridge (`window.PBApp`) — **+0 (stays 37)**

`Icon`, `useSwipeDownToClose`, `useBodyScrollLock`, `sanitizeDecimalInput` — **all already bridged**
(inc-13/15/18). Injected as the render-time lead read
`const { Icon, useSwipeDownToClose, useBodyScrollLock, sanitizeDecimalInput } = window.PBApp;`.

### Reads module globals -> IIFE — **+1 (`positionCostCcy`, `PBCore`)**

`positionCostCcy` (`pb-core.js:374`, `(p && p.costCurrency) || marketCurrency(p.market)`) is the only
identifier not already present in the bucket IIFE. Added as `const positionCostCcy =
PBCore.positionCostCcy;`, grouped with the other money helpers (after `valuePositionInCostCcy`).
Already in the bucket IIFE and reused unchanged: `parseDecimal`, `priceKey`, `marketCurrency`,
`convertCcy`, `CURRENCY_SYMBOLS`, `MARKET_CURRENCY`, and the React hooks `useState`/`useRef`/`useEffect`.
`PBStore.usePricesMap()` is a free global (no bridge). `React` is a UMD global.

### `content.test.mjs` unaffected

No `PBContent` bind moves out of app.js. `CURRENCY_SYMBOLS` (11 app.js refs), `positionCostCcy` (12),
`marketCurrency` (19), `MARKET_CURRENCY` (12), `DISPLAY_CURRENCIES` (3) all keep other app.js consumers,
so every `const X = PBContent.X` / `const X = PBCore.X` bind line stays live in app.js — the delegation
guard passes with **no test change**.

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; the body carries `\xB7` escapes for `·`).
Locate by content markers, not fixed line numbers: block = the `// Buy more of an existing holding…`
comment through the `}` immediately before `function computeFxSnapshot(`. Assert the comment is exactly
3 lines above the signature and the block ends at `}`. Splice with a replacement array (avoids
`$'`/`$&` expansion). All markers validated in memory before any write; both files written last.

Into `pb-modals.js` (before the registration block; hoisting makes order moot):
- **1 render-time lead read** injected as the first body statement (single-line signature -> after
  line 1): `const { Icon, useSwipeDownToClose, useBodyScrollLock, sanitizeDecimalInput } = window.PBApp;`.
- **1 new IIFE read** `const positionCostCcy = PBCore.positionCostCcy;` after `valuePositionInCostCcy`.
- Register `window.PBModals.BuyModal = BuyModal;` after the `ImportModal` registration.

In `app.js`: block -> pointer comment + `const BuyModal = PBModals.BuyModal;`. The bridge publish line is
**unchanged**. The invocation site (`React.createElement(BuyModal, {…})`) is untouched — TDZ-safe (the
bind runs at load; the call site is inside a render body).

## Wiring

- `sw.js` `CACHE_NAME` **v69 -> v70**. Only shipped-file wiring.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the harnesses — bucket already wired;
  `deploy-assets` stays green.
- `architecture-map.html` — append the inc-20 clause to the bridge-history note (count stays 37).
- `REFACTOR_STATUS.md` — Done + Current-state (9 modals, bridge 37, v70), SellModal now next.

## Verification gate

1. `node --check` app.js + pb-modals.js + sw.js.
2. Full node suite (**27**; **money gate** unaffected — no cost-basis/pb-core money code moved;
   **content guard**; `deploy-assets`).
3. Anti-drift greps: `function BuyModal` = 0 app.js / 1 pb-modals.js; pointer + bind present;
   registration present; `positionCostCcy` IIFE read present; lead read present; **bridge = 37**.
4. **Verbatim proof:** brace-matched extraction of the moved body diffed against `HEAD:app.js` —
   byte-identical aside from the single injected lead read.
5. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED** (patched scratchpad copy) — proves app.js
   still mounts with the moved modal.
6. **Buy characterization render probe** (throwaway, run **before & after** the move): render
   `BuyModal` directly with a spy `onBuy`; drive shares/price inputs; assert the preview `addAmount` +
   `newAvg` and the `onBuy` payload for a **US holding** (10 @ $100, buy 5 @ $120 -> avg **$106.67**,
   amount **$600.00**, `onBuy('AAPL','US',5,120,today,'','USD')`) and a **crypto-in-ZAR holding** (1 @
   R500000, buy 0.5 @ R600000 -> avg **R533333.33**, amount **R300000.00**, `onBuy('BTC','CRYPTO',0.5,
   600000,today,'','ZAR')` — pins `positionCostCcy` = ZAR + the `CURRENCY_SYMBOLS['ZAR']` = 'R' symbol).
   U+FFFD scan.

## Out of scope / deferred

- **`SellModal`** (inc-21, this session) and **`PositionModal`** (inc-22, later) — each characterization
  test first.
- The persisting merge/re-average lives in the `onBuy` mutator (data layer) — not moved.
- Extracting the inline averaging into a durable `pb-core` helper — a separate future increment, not a
  verbatim move.

## Commit note

Development on `claude/refactor-plan-continuation-0c5cqc`; commit + push to the feature branch.
**No PR; `main` never pushed.** Scratchpad scripts never committed.

## Measured read-out (2026-07-20, on execution)

All gates green — the prediction held exactly.
- **Rule-#3 pin green before AND after** the move. Baseline (`BuyModal source: app.js-global`) and
  post-move (`BuyModal source: PBModals`) render probes both **ALL PASSED**, identical outputs: US avg
  **$106.67** / amount **$600.00** / `onBuy('AAPL','US',5,120,2026-07-20,'','USD')` / `onClose` once;
  crypto avg **R533333.33** / amount **R300000.00** / `onBuy('BTC','CRYPTO',0.5,600000,2026-07-20,'',
  'ZAR')`.
- **Verbatim:** brace-matched moved body is **byte-identical to `HEAD:app.js`** (93 fn lines each) aside
  from the injected lead read at fn-relative line 1.
- `node --check` app.js + pb-modals.js + sw.js OK. Full node suite **27/27** (money gate + content guard
  + deploy-assets). U+FFFD = 0 on all modified files; BOM + LF preserved; no CRLF introduced.
- Anti-drift: `function BuyModal` **0 app.js / 1 pb-modals.js**; pointer + `const BuyModal =
  PBModals.BuyModal` at the old def site (app.js); registration after `ImportModal` (pb-modals.js);
  `positionCostCcy` IIFE read present once; **bridge 37** (unchanged).
- Mount gate `verify-refresh-behavior` **ALL PASSED** (app mounts; auto-poll / manual-refresh / lazy-tab
  / session-badge all green).

**Bucketing economics, measured:**
- `app.js` **9332 -> 9242 (-90)** (96-line block -> 6-line pointer comment + bind), `pb-modals.js`
  **3105 -> 3204 (+99)** (96-line block + 1 lead read + 1 IIFE read + 1 registration), `sw.js`
  **v69 -> v70**. **Zero** index/static/harness edits.
- **Bridge 37 (unchanged, +0), IIFE +1 (`positionCostCcy`).** The cleanest possible money-tier move —
  the four bridge members it needs were already published by earlier increments.
- **Rule #3 honored:** the in-body averaging + the `onBuy` payload are pinned by a before/after probe
  and left byte-identical; the persisting re-average (the `onBuy` mutator) was never in the modal.

**Conclusion:** the buy sheet is extracted; the bucket holds **9 modals + the detail subtree + the
settings subtree**; bridge **37**; `sw` `CACHE_NAME` **v70**. The money tier is opened — `SellModal`
(inc-21) is next, then `PositionModal` (inc-22).
