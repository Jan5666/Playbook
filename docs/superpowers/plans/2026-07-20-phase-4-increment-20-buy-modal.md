# Phase 4 increment 20 — extract `BuyModal` — Implementation Plan

**Goal:** Move the 96-line block `app.js:9050–9145` (lead comment + `BuyModal`) into `pb-modals.js`.
Bridge **unchanged (37)**; **+1 IIFE read** (`positionCostCcy`, `PBCore`). First money-tier move —
rule #3 requires a **characterization test pinning current behavior first**, then a verbatim relocation.
The persisting merge/re-average lives in the `onBuy` mutator (data layer), not the modal.

**Branch:** `claude/refactor-plan-continuation-0c5cqc` (off latest `origin/main` @ inc-19/PR #31).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; body carries `\xB7` escapes for `·`. Replacement-array
  splice; markers validated in memory before any write.
- **Bridge +0:** `Icon`, `useSwipeDownToClose`, `useBodyScrollLock`, `sanitizeDecimalInput` already
  bridged (inc-13/15/18).
- **IIFE +1:** `positionCostCcy` (`pb-core.js:374`) — the only free identifier not already in the bucket
  IIFE. `parseDecimal`/`priceKey`/`marketCurrency`/`convertCcy`/`CURRENCY_SYMBOLS`/`MARKET_CURRENCY`
  are already there.
- **1 lead read:** the `window.PBApp` destructure, injected after the single-line signature.
- Rule #3: the in-body averaging + the `onBuy` payload must be **pinned before the move** and left
  byte-identical.

## Task 0 — characterization pin (rule #3, BEFORE any move)

`scratchpad/probe-buy.mjs`: serve the app stack with a locally-`npm i`'d React (`/__react.js` +
`/__react-dom.js`; unpkg is 403), mount `BuyModal` in an isolated `#probe` root against **current
app.js**, drive shares/price, assert `addAmount` + `newAvg` + the spy `onBuy` payload for a US holding
and a crypto-in-ZAR holding. Must be **green before the move** (baseline: `BuyModal source:
app.js-global`).

## Task 1 — move block + inject lead read + IIFE read + register + bump sw

Files: `app.js` (block -> pointer+bind; bridge unchanged), `pb-modals.js` (1 IIFE read + block + 1 lead
read + registration), `sw.js` (v69 -> v70). Throwaway `scratchpad/move-buy.mjs`.

Slice: the `// Buy more of an existing holding…` comment .. the `}` before `function
computeFxSnapshot(`. Assert comment is 3 lines above `function BuyModal({ position, fxRates, onClose,
onBuy }) {` and the block ends at `}`. Inject the lead read after the signature line. Insert
`const positionCostCcy = PBCore.positionCostCcy;` after `valuePositionInCostCcy`. Insert the block
before `window.PBModals = window.PBModals || {};`; register after the `ImportModal` registration.
`node --check` all three.

## Task 2 — docs

`REFACTOR_STATUS.md` Done/Current-state (9 modals, bridge 37, v70; SellModal next).
`architecture-map.html`: append the inc-20 clause to the bridge-history note (count stays 37). Spec +
this plan under `docs/superpowers/`.

## Task 3 — verify

Node suite (money gate + content guard + deploy-assets) green; anti-drift greps (function count 0/1;
pointer+bind; registration; `positionCostCcy` IIFE read; lead read; bridge 37); **verbatim proof**
(brace-matched moved body == `HEAD:app.js` aside from the lead read); mount gate
`verify-refresh-behavior` ALL PASSED; **Buy render probe re-run AFTER the move** (now `BuyModal source:
PBModals`) — identical outputs to the baseline; U+FFFD scan.

## Task 4 — read-out + progress doc + commit

Append the measured read-out to the spec. Refresh `REFACTOR_STATUS.md`. Commit + push to the feature
branch. **No PR; never `main`.**

## Self-review

- Money math (avg re-blend + `onBuy` payload + cost-currency seed) -> pinned by a before/after render
  probe (US + crypto-in-ZAR); the persisting re-average is in the `onBuy` mutator, not moved.
- Inventory complete (+0 bridge / +1 IIFE; residue after subtracting locals/natives/props/already-wired
  is exactly `positionCostCcy`) -> anti-drift greps + verbatim diff.
- Load order: `PBCore` before the bucket (IIFE read OK). Single-line signature -> lead read after line 1.
- Encoding (`\xB7` escapes only, no literal glyphs) -> U+FFFD scan + BOM/LF preserved + verbatim diff.
- `content.test.mjs` unaffected (no `PBContent` bind leaves app.js) -> full node suite green.
