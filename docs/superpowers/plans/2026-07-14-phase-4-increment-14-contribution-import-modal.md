# Phase 4 increment 14 — extract `ContributionImportModal` into `pb-modals.js` — Implementation Plan

**Goal:** Move `ContributionImportModal` (+ its own doc comment) verbatim from `app.js` into the
`pb-modals.js` bucket, grow the `window.PBApp` bridge by three, add a `PBContent` IIFE read, and
bump the sw cache. Completes the deposit/withdraw modal pair.

**Branch:** `claude/refactor-plan-next-7cr7q5` (stacks on inc-13).

## Correction to the brief (important)

The task brief called inc-14 a "pure cheap add — no bridge growth, no new IIFE binds", based on
a dependency inventory that **omitted four symbols** the modal actually uses:
`uid` (app.js:1364), `parseCashFlowsFromText` (app.js:5877), `parseCashFlowFile` (app.js:5882)
— all app.js internals — and `CURRENCY_SYMBOLS` (a `PBContent` global). A faithful extraction
therefore **must** bridge the three internals and add one IIFE `PBContent` read. This plan does
that, following the module's own convention.

## Global constraints

- **Verbatim move via a Node slice script — never the Edit tool.** BOM + literal `· — … ' "`.
  Read/write `'utf8'`, split/join `'\n'`. Replacement **function** for the splice.
- **Bridge grows by three** (`+uid, +parseCashFlowsFromText, +parseCashFlowFile`); all stay in
  app.js -> TDZ-safe (defined before the publish).
- **Globals read directly, internals via the bridge.** `CURRENCY_SYMBOLS` -> `PBContent` IIFE
  read; the three helpers -> bridge.

## Task 1 — extract the modal + grow the bridge + add the IIFE PBContent read + bump sw

**Files:** `app.js` (remove modal + doc comment -> comment + 1 bind; grow bridge),
`pb-modals.js` (add `const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS;`; splice modal +
registration), `sw.js` (cache bump). Throwaway: `scratchpad/inc14-extract.mjs`.

Slice-script outline:
- app.js: find `function ContributionImportModal(`, walk the start back over the leading `//`
  doc-comment block, end at the next top-level `function ` (assert preceding line is `}`).
- Inject the 7-member lead read (`Icon, useSwipeDownToClose, useBodyScrollLock,
  sanitizeDecimalInput, uid, parseCashFlowsFromText, parseCashFlowFile`) after the signature.
- Replace the span with the pointer comment + `const ContributionImportModal =
  PBModals.ContributionImportModal;`.
- Grow bridge: exact-line replace adding `, uid, parseCashFlowsFromText, parseCashFlowFile`.
- pb-modals.js: add the `PBContent.CURRENCY_SYMBOLS` read after the inc-13 `PBCore` read; insert
  the modal before the `window.PBModals = ...` block (replacement function form); add the
  `window.PBModals.ContributionImportModal` registration after the `ContributionModal` one.
- sw.js: `CACHE_NAME` `v61 -> v62`.

Then: `node --check app.js && node --check pb-modals.js`.

## Task 2 — docs sync

`architecture-map.html`: bridge note **14 -> 17** (add the three helpers).

## Task 3 — verify

1. Full node suite green; `deploy-assets` green.
2. Anti-drift greps (spec Verification gate 3).
3. **Mount gate:** `verify-refresh-behavior.mjs` -> ALL PASSED.
4. **Render check:** `verify-modals.mjs` renders the import modal (currency chips exercise
   `CURRENCY_SYMBOLS`); rerun on the flaky CDP race. A throwaway paste+Review probe drives
   `parseCashFlowsFromText`+`uid` and asserts >=2 parsed rows.

## Task 4 — measured read-out + docs

Append the read-out to the spec (deltas, bridge = 17, bucket = 4, sw v62). Commit + push. No PR;
never `main`.

## Self-review

- Scope -> Task 1.
- Corrected dependency inventory (4 omitted symbols) -> bridged/PBContent-read; Task 3 greps +
  paste probe verify.
- Bridge +3 only -> exact-line replace + anti-drift grep.
- Slice footgun -> replacement-function form; `node --check` confirms.
- Wiring (cheap: sw bump only; no new-file tax) -> `deploy-assets` green confirms.
- Encoding (BOM + literal `· — … ' "` verbatim) -> render-check U+FFFD check.
- Out-of-scope (money/alert modals, portal, Vite) -> honored.
