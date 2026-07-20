# Phase 4 increment 21 — extract `SellModal` — Implementation Plan

**Goal:** Move the 138-line `SellModal` block into `pb-modals.js`. Bridge **unchanged (37)**;
**+0 IIFE reads** — the most self-contained money modal (every dependency already wired by inc-11..20).
Second money-tier move — rule #3 requires a **characterization test first**, then a verbatim relocation.
The realized-gain math lives in the `onSell` mutator (data layer), not the modal.

**Branch:** `claude/refactor-plan-continuation-0c5cqc` (off latest `origin/main` @ inc-19/PR #31, after inc-20).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; body carries `\xB7` escapes for `·`. Replacement-array
  splice; markers validated in memory before any write.
- **Bridge +0 / IIFE +0:** `Icon`/`useSwipeDownToClose`/`useBodyScrollLock`/`sanitizeDecimalInput`
  already bridged; `priceKey`/`MARKET_CURRENCY`/`parseDecimal` + React hooks already in the bucket IIFE.
- **1 lead read:** the `window.PBApp` destructure, after the single-line signature.
- Rule #3: the %<->shares sync, the pnl preview, and the `onSell` payload (6 args, no costCcy) must be
  **pinned before the move** and left byte-identical.

## Task 0 — characterization pin (rule #3, BEFORE any move)

`scratchpad/probe-sell.mjs`: mount `SellModal` in an isolated `#probe` root against **current app.js**;
drive the % box, the shares box, and the chips; assert the sync (% 50 -> shares 5; shares 2.5 -> % 25;
chip All -> 10), `pnl` sign/format (+$100.00 up; +$200.00 at 100%; loss $100.00 down, no `+`), the
validity cap (15 > 10 disables "Record sale" + "exceeds your holding"), and the 6-arg `onSell` payload.
Must be **green before the move** (`SellModal source: app.js-global`).

## Task 1 — move block + inject lead read + register + bump sw

Files: `app.js` (block -> pointer+bind; bridge unchanged), `pb-modals.js` (block + 1 lead read +
registration), `sw.js` (v70 -> v71). Throwaway `scratchpad/move-sell.mjs`.

Slice: `function SellModal({ position, onClose, onSell }) {` .. the `}` before the inc-20
`// BuyModal moved to pb-modals.js (Phase 4 inc-20).` pointer. Assert the block ends at `}`. Inject the
lead read after the signature. Insert the block before `window.PBModals = window.PBModals || {};`;
register after the `BuyModal` registration. `node --check` all three.

## Task 2 — docs

`REFACTOR_STATUS.md` Done/Current-state (10 modals, bridge 37, v71; PositionModal the sole remaining,
deferred). `architecture-map.html`: extend the money-tier history note (count stays 37). Spec + this
plan under `docs/superpowers/`.

## Task 3 — verify

Node suite (money gate + content guard + deploy-assets) green; anti-drift greps (function count 0/1;
pointer+bind; registration; lead read; bridge 37); **verbatim proof** (brace-matched moved body ==
`HEAD:app.js` aside from the lead read); mount gate `verify-refresh-behavior` ALL PASSED; **Sell render
probe re-run AFTER the move** (now `SellModal source: PBModals`) — identical outputs to the baseline;
U+FFFD scan.

## Task 4 — read-out + progress doc + commit

Append the measured read-out to the spec. Refresh `REFACTOR_STATUS.md`. Commit + push to the feature
branch. **No PR; never `main`.**

## Self-review

- Money math (%<->shares sync + pnl + `onSell` payload) -> pinned by a before/after render probe (sell +
  loss + over-holding); the realized-gain math is in the `onSell` mutator, not moved.
- Inventory complete (+0 bridge / +0 IIFE; residue after subtracting locals/natives/props/already-wired
  is empty) -> anti-drift greps + verbatim diff.
- Load order fine (all deps already in the bucket). Single-line signature -> lead read after line 1.
- Encoding (`\xB7` escapes only) -> U+FFFD scan + BOM/LF preserved + verbatim diff.
- `content.test.mjs` unaffected (no `PBContent` bind leaves app.js) -> full node suite green.
