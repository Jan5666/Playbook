# Phase 4 increment 19 — extract `ImportModal` — Implementation Plan

**Goal:** Move the 612-line block `app.js:8578–9189` (`ImportModal`) into `pb-modals.js`. Bridge
**33 -> 37 (+4)**; **+7 IIFE reads** (all `PBImport.*`); `DATA` read at render time. Safe display +
delegate move — no rule-#3/#5/MONEY-GATE code (the import mutator lives in the data layer, reached via
the `onImport` prop).

**Branch:** `claude/refactoring-plan-fs89s3` (off latest `origin/main` @ inc-18/PR #30).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; literal `→ — … " " · ×`. Replacement-array splice.
- **Bridge +4:** `TickerSearch` (multi-caller 7089/9365) + the impure readers `parseImportFile`,
  `ocrImageFile`, `searchListingsMulti` (single-caller but each roots a cluster of stays-put app.js
  infra + module-level mutable state — bridge, per the inc-14 `parseCashFlowFile` precedent). Their
  app.js definitions and `PBImport` binds stay put.
- **IIFE +7:** `parseHoldingsFromText`, `rankImportCandidates`, `companyNameScore`,
  `looksLikeTickerToken`, `normaliseCompanyName`, `parseEasyEquitiesScreenshot`, `dedupeEeHoldings` —
  first `PBImport` reads in the bucket; `pb-import.js` loads before `pb-modals.js`.
- **2 lead reads:** the `window.PBApp` destructure (7 pre-bridged + 4 new) **and**
  `const DATA = window.PB_DATA;` (render-time — data.js loads *after* the bucket; the `pb-views.js`
  pattern).
- import mutator / realized-gain math stay in the data layer; the modal only builds a payload and awaits
  `onImport`.

## Task 1 — move block + inject lead reads + IIFE reads + register + bump sw

Files: `app.js` (block -> pointer+bind; bridge +4), `pb-modals.js` (7 IIFE reads + block + 2 lead reads
+ registration), `sw.js` (v68 -> v69). Throwaway `scratchpad/move-import-modal.mjs`.

Slice: `function ImportModal({ onClose, onImport, defaultMarket }) {` .. the `}` before
`function PositionModal(_ref12) {`. Assert first line, last line `}`, next-line signature, body length
612. Bridge edit in place (append `, TickerSearch, parseImportFile, ocrImageFile, searchListingsMulti`
before ` };`) before the splice. Inject the 2 lead reads after line 1 (single-line signature). Insert
the 7 IIFE reads after the `RIBBON_CATALOG` bucket read. Insert the block before
`window.PBModals = window.PBModals || {};`; register `window.PBModals.ImportModal = ImportModal;` after
the `AlertsModal` registration. `node --check` all three.

## Task 2 — docs

`architecture-map.html`: bridge count 31→37 (history note + count blurb); append inc-19 clause; refresh
the published member list; update the `import-ui` node (ImportModal -> pb-modals.js, TickerSearch stays
app.js). Spec + this plan under `docs/superpowers/`. Refresh `REFACTOR_STATUS.md` Done/Current-state
(8 modals, bridge 37, v69).

## Task 3 — verify

Node suite (money gate + content guard 14/14 + deploy-assets) green; anti-drift greps (function count;
4 stays-put helpers once; lead reads; pointer+bind; registration; bridge 37); mount gate
`verify-refresh-behavior` ALL PASSED; **Import render probe** (render `PBModals.ImportModal` directly
with mocked Yahoo search+quote; assert bridge/registration/`PB_DATA` wiring, input stage, paste -> 2
matched review cards, `DATA` sector field, `fmt` amount line, manual-matcher `TickerSearch` subtree; no
`onImport`; U+FFFD scan).

## Task 4 — read-out + progress doc + commit

Append read-out to spec. Refresh `REFACTOR_STATUS.md`. Commit + push to the feature branch.
**No PR; never `main`.**

## Self-review

- Scope (impure readers cascade -> bridge not move; matching logic in pb-import.js; `onImport`
  delegate) -> verified by 237-identifier inventory + reading the 3 readers' bodies.
- Inventory complete (+4 bridge / +7 IIFE / `DATA` render-time; residue after subtracting
  locals/natives/props is exactly these) -> anti-drift greps + leftover scan.
- Load order: `PBImport` before bucket (IIFE OK); `data.js` after bucket (`DATA` must be render-time,
  not IIFE) -> matched `pb-views.js`.
- Single-line signature -> inject lead reads after line 1.
- Rule #3/#5 (no cost-basis/import-matching/backup code moves; delegated via `onImport`) -> render probe
  pins render incl. a matched row without firing the import.
- Encoding (`→ — … " " · ×`) -> U+FFFD scan on files + non-ASCII count match vs original body.
