# Phase 4 increment 21 — second money modal: `SellModal` -> `pb-modals.js`

**Date:** 2026-07-20
**Branch:** `claude/refactor-plan-continuation-0c5cqc` (off latest `origin/main` @ inc-19/PR #31, after inc-20)
**Status:** executed — all gates green (see measured read-out)

## Goal

Move the "record a sale" sheet `SellModal` (`app.js`, **138 lines**, no lead comment) into the
`pb-modals.js` bucket as a **byte-identical verbatim move**. Second modal of the rule-#3-gated money
tier — a **characterization test pinning current behavior comes first**, then the verbatim relocation.
The cleanest possible dependency footprint: **0 new bridge members, 0 new IIFE reads** (every dependency
was already published by earlier increments).

## The money behavior being moved (what rule #3 protects)

- **%↔shares sync (both directions + chips):** `sharesFromPct(pct)` clamps to [0,100], sends 100% to the
  whole position (`position.shares.toString()`), else `position.shares * c / 100` rounded to 4 dp with
  trailing zeros trimmed; `applyPctInput` drives shares from the % box; `applyPctChip` from a 25/50/75/
  100 chip; `applySharesInput` reverses it (`n / position.shares * 100`, 2 dp).
- **P/L preview:** `pnl = (numPrice - position.costBasis) * numShares`; rendered
  `(pnl >= 0 ? '+' : '') + ccy + Math.abs(pnl).toFixed(2)` with up/down styling.
- **Validity cap:** `valid = numShares > 0 && numShares <= position.shares && numPrice > 0` (over-holding
  disables "Record sale" and shows "exceeds your holding").
- **Sell payload:** `onSell(position.ticker, position.market, numShares, numPrice, sellDate, notes)` —
  **6 args, no `costCcy`** (unlike Buy). The realized gain / proceeds are computed in the `onSell`
  mutator (data layer), **not** the modal — that code is untouched.

## Dependency inventory (every free identifier classified)

After subtracting locals / natives / props / already-bridged / already-IIFE-read, the residue is
**empty**. **+0 bridge, +0 IIFE.**

### Reaches app.js internals -> bridge (`window.PBApp`) — **+0 (stays 37)**

`Icon`, `useSwipeDownToClose`, `useBodyScrollLock`, `sanitizeDecimalInput` — all already bridged.
Injected as the render-time lead read
`const { Icon, useSwipeDownToClose, useBodyScrollLock, sanitizeDecimalInput } = window.PBApp;`.

### Reads module globals -> IIFE — **+0**

`priceKey`, `MARKET_CURRENCY`, `parseDecimal` and the React hooks `useState`/`useRef`/`useEffect` are
**already** in the bucket IIFE (inc-11..20). `PBStore.usePricesMap()` is a free global; `React` is a
UMD global; `Math`/`parseFloat`/`isFinite` are native. `SellModal` never reads `positionCostCcy` (it
uses `position.costBasis` directly) — nothing new to add.

### `content.test.mjs` unaffected

No `PBContent` bind moves out of app.js; the delegation guard passes with **no test change**.

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; the body carries `\xB7` escapes for `·`).
Locate by content markers: block = `function SellModal({ position, onClose, onSell }) {` through the `}`
immediately before the inc-20 `// BuyModal moved to pb-modals.js (Phase 4 inc-20).` pointer. Assert the
block ends at `}`. Splice with a replacement array; all markers validated in memory before any write.

Into `pb-modals.js` (before the registration block; hoisting makes order moot):
- **1 render-time lead read** injected after the single-line signature.
- Register `window.PBModals.SellModal = SellModal;` after the `BuyModal` registration.

In `app.js`: block -> pointer comment + `const SellModal = PBModals.SellModal;`. Bridge publish line
**unchanged**. The invocation site is untouched — TDZ-safe.

## Wiring

- `sw.js` `CACHE_NAME` **v70 -> v71**. Only shipped-file wiring.
- **Zero** edits to index.html / static.yml / SHELL_ASSETS / the harnesses — bucket already wired.
- `architecture-map.html` — extend the money-tier history note (count stays 37).
- `REFACTOR_STATUS.md` — Done + Current-state (10 modals, bridge 37, v71); `PositionModal` the sole
  remaining money modal (deferred this session).

## Verification gate

1. `node --check` app.js + pb-modals.js + sw.js.
2. Full node suite (**27**; money gate unaffected — no pb-core money code moved; content guard;
   deploy-assets).
3. Anti-drift greps: `function SellModal` = 0 app.js / 1 pb-modals.js; pointer + bind; registration;
   lead read; **bridge = 37**.
4. **Verbatim proof:** brace-matched moved body == `HEAD:app.js` aside from the lead read.
5. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED**.
6. **Sell characterization render probe** (throwaway, **before & after**): spy `onSell`; pin the
   %↔shares sync (% 50 -> shares 5; shares 2.5 -> % 25; chip All -> shares 10), `pnl` sign/format
   (+$100.00 up; +$200.00 at 100%; loss $100.00 down, no `+`), the validity cap (15 > 10 disables
   "Record sale", "exceeds your holding"), and the **6-arg** `onSell('AAPL','US',10,120,today,'')`.
   U+FFFD scan.

## Out of scope / deferred

- **`PositionModal`** (inc-22) — the last money modal (new `MarketPicker` bridge, `DATA` render-time,
  async submit, edit-confirm portal); deferred to a later session per the Buy+Sell scope.
- The realized-gain math lives in the `onSell` mutator (data layer) — not moved.

## Commit note

Development on `claude/refactor-plan-continuation-0c5cqc`; commit + push to the feature branch.
**No PR; `main` never pushed.** Scratchpad scripts never committed.

## Measured read-out (2026-07-20, on execution)

All gates green — the prediction held exactly.
- **Rule-#3 pin green before AND after** the move. Baseline (`SellModal source: app.js-global`) and
  post-move (`SellModal source: PBModals`) probes both **ALL PASSED**, identical outputs: % 50 -> shares
  **5**; shares 2.5 -> % **25**; chip All -> **10**; pnl **+$100.00** (up) / **+$200.00** at 100% / loss
  **$100.00** (down, no `+`); shares 15 disables "Record sale" + "exceeds your holding";
  `onSell('AAPL','US',10,120,2026-07-20,'')` (6 args, no costCcy); `onClose` once.
- **Verbatim:** brace-matched moved body **byte-identical to `HEAD:app.js`** (138 lines each) aside from
  the injected lead read.
- `node --check` OK. Full node suite **27/27** (money gate + content guard + deploy-assets). U+FFFD = 0;
  BOM + LF preserved; no CRLF.
- Anti-drift: `function SellModal` **0 app.js / 1 pb-modals.js**; pointer + `const SellModal =
  PBModals.SellModal` at the old def site; registration after `BuyModal`; **bridge 37** (unchanged).
- Mount gate `verify-refresh-behavior` **ALL PASSED**.

**Bucketing economics, measured:**
- `app.js` **9242 -> 9109 (-133)** (138-line block -> 5-line pointer), `pb-modals.js` **3204 -> 3344
  (+140)** (138-line block + 1 lead read + 1 registration), `sw.js` **v70 -> v71**. Zero index/static/
  harness edits.
- **Bridge 37 (unchanged, +0), IIFE +0.** The most self-contained money modal — every dependency was
  already wired by inc-11..20.
- **Rule #3 honored:** the %↔shares sync, the pnl preview, and the `onSell` payload are pinned by a
  before/after probe and left byte-identical; the realized-gain math was never in the modal.

**Conclusion:** the sell sheet is extracted; the bucket holds **10 modals + the detail subtree + the
settings subtree**; bridge **37**; `sw` `CACHE_NAME` **v71**. Two of the three money modals are done;
only **`PositionModal`** remains of Phase-4 modal extraction.
