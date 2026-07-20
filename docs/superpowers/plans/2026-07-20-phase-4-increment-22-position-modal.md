# Phase 4 increment 22 — extract `PositionModal` — Implementation Plan

**Goal:** Move the 326-line `PositionModal` block into `pb-modals.js`. Bridge **37 -> 38**
(**+`MarketPicker`**, a multi-caller shared with `WatchlistView`); **+0 IIFE reads** (every PB* global
already in the bucket IIFE). Third and final money-tier move — rule #3 requires a **characterization
test first**, then a verbatim relocation. The add/update persistence lives in the
`addPosition`/`updatePosition` mutators (data layer) via `onSave`, not the modal. **Completes Phase 4
modal extraction.**

**Branch:** `claude/refactor-plan-continuation-szkz3n` (off latest `origin/main` @ inc-21/PR #32).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; body carries literal `£ € · – —`, `≈`, `…`.
  Replacement-array splice; markers + coarse brace balance validated in memory before any write.
- **Bridge +1 (`MarketPicker`) / IIFE +0:** `Icon`/`useSwipeDownToClose`/`useBodyScrollLock`/
  `SectorWeightRows`/`TickerSearch`/`sanitizeDecimalInput` already bridged; `parseDecimal`/
  `CURRENCY_SYMBOLS`/`marketCurrency`/`positionCostCcy`/`fetchQuote`/`MARKET_CURRENCY`/
  `DISPLAY_CURRENCIES` + React hooks already in the bucket IIFE.
- **1 lead read + 1 DATA read:** the `window.PBApp` destructure and `const DATA = window.PB_DATA;`,
  after the single-line signature.
- Rule #3: `perUnitCost` (crypto total/shares), the save payload (incl. the `costCurrency`-persist rule),
  and `diffChanges` must be **pinned before the move** and left byte-identical.

## Task 0 — characterization pin (rule #3, BEFORE any move)

`scratchpad/probe-position.mjs`: render `PositionModal` in an isolated `#probe` root against **current
app.js** (full app mounted so the bridge is live); mock `window.fetch` so the real `fetchQuote` resolves
offline; spy `onSave`/`onClose`. Drive four scenarios — **A** Add/US, **B** Add/crypto-ZAR "Total spent",
**C** Edit/no-listing-change (diff + confirm portal), **D** no-op edit. Assert the payload/`perUnitCost`/
`diffChanges`. Must be **green before the move** (`PositionModal source: app.js-global`); capture the
result digest for the after-comparison.

## Task 1 — move block + inject lead read + register + bump sw

Files: `app.js` (block -> pointer+bind; **+`MarketPicker`** on the bridge line), `pb-modals.js` (block +
1 lead read + 1 DATA read + registration), `sw.js` (v71 -> v72). Throwaway `scratchpad/move-inc22.mjs`.

Slice: `function PositionModal(_ref12) {` .. the `}` before the inc-21 `// SellModal moved to
pb-modals.js (Phase 4 inc-21).` pointer. Assert the block ends at `}` (326 lines). Inject the lead read +
DATA read after the signature. Insert the block before `window.PBModals = window.PBModals || {};`;
register after the `SellModal` registration. Append `MarketPicker` to the `window.PBApp = { … }` publish
line. `node --check` all three.

## Task 2 — docs

`REFACTOR_STATUS.md` Done/Current-state (**11 modals, bridge 38, v72; Phase 4 modal extraction
COMPLETE**). `architecture-map.html`: bridge **37 -> 38** (+`MarketPicker`) + inc-22 history note. Spec +
this plan under `docs/superpowers/`.

## Task 3 — verify

Node suite (money gate + content guard + deploy-assets) green; anti-drift greps (function count 0/1;
pointer+bind; registration; lead read; **bridge 38** with `MarketPicker`; `function MarketPicker` still 1
in app.js); **verbatim proof** (brace-matched moved body == `HEAD:app.js` aside from the lead read +
DATA); mount gate `verify-refresh-behavior` ALL PASSED; **Position render probe re-run AFTER the move**
(now `PositionModal source: PBModals`, bridge has `MarketPicker`) — **result digest identical** to the
baseline; U+FFFD scan.

## Task 4 — read-out + progress doc + commit

Append the measured read-out to the spec. Refresh `REFACTOR_STATUS.md`. Commit + push to the feature
branch. **No PR; never `main`.**

## Self-review

- Money math (`perUnitCost` + save payload + `costCurrency`-persist rule + `diffChanges`) -> pinned by a
  before/after render probe (Add/US + Add/crypto-ZAR + Edit + no-op); the persistence + FX math are in the
  `onSave` mutator, not moved.
- Inventory complete (+1 bridge `MarketPicker` / +0 IIFE; residue after subtracting locals/natives/props/
  already-wired is the single shared multi-caller) -> anti-drift greps + verbatim diff.
- Load order fine (all module deps already in the bucket; `MarketPicker` + the bridge publish are TDZ-safe
  — read at render time). Single-line signature -> lead read + DATA read after line 1.
- Encoding (`£ € · – —`, `≈`, `…` literals) -> U+FFFD scan + BOM/LF preserved + verbatim diff.
- `content.test.mjs` unaffected (no `PBContent` bind leaves app.js) -> full node suite green.
