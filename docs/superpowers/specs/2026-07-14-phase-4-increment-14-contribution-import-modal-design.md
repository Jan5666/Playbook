# Phase 4 increment 14 — fourth modal: `ContributionImportModal` -> existing `pb-modals.js`

**Date:** 2026-07-14
**Branch:** `claude/refactor-plan-next-7cr7q5` (stacks on inc-13, unmerged)
**Status:** design approved by Jan (2026-07-14: completes the deposit/withdraw modal pair)

## Goal

Move the sibling of inc-13's `ContributionModal` out of `app.js`: the bulk
deposit/withdrawal importer (paste text or drop a CSV/XLSX -> an editable review table ->
commit). Display + input only; the actual cash-flow persistence happens in the parent via
`onImport`. No money math in the modal -> outside CLAUDE.md rule #3.

## Dependency inventory (verified on `app.js` @ post-inc-13) — CORRECTED

> **Deviation from the task brief.** The brief characterised inc-14 as a "pure cheap add — no
> bridge growth, no new IIFE binds". That was based on an **incomplete** dependency inventory:
> it listed only `Icon`, the hooks, `React.Fragment`, `parseDecimal`, `sanitizeDecimalInput`.
> The modal body in fact also references **four** further symbols the brief omitted. Extracting
> it faithfully therefore required bridge growth + one IIFE global read. The established
> convention ("bridge app.js internals; read true module globals directly") resolved each:

| Dependency | Source | Disposition |
|---|---|---|
| `useState`, `useRef` | React UMD | already in the bucket IIFE |
| `useSwipeDownToClose`, `useBodyScrollLock`, `Icon` | app.js | **bridge** — already present |
| `React.Fragment` | React UMD | native |
| `parseDecimal` | `PBCore.parseDecimal` | IIFE read — added inc-13 |
| `sanitizeDecimalInput` | app.js:1377 (`function`) | **bridge** — added inc-13 |
| `uid` | app.js:1364 (`function`) | **bridge** (new) — app.js internal, stays |
| `parseCashFlowsFromText` | app.js:5877 (`function`) | **bridge** (new) — app.js internal, stays |
| `parseCashFlowFile` | app.js:5882 (`async function`) | **bridge** (new) — app.js internal, stays |
| `CURRENCY_SYMBOLS` | `PBContent.CURRENCY_SYMBOLS` (app.js:453 re-binds it) | **IIFE read** (new) — a true module global, read directly like `parseDecimal`, NOT bridged |

`app.js` is a top-level classic script (not an IIFE), so those internals technically leak as
global bindings; but relying on that leakage is exactly the implicit coupling the refactor
exists to remove, and inc-12 already chose to bridge `fetchSectorTrend`/`ZoomPanHeatmap` rather
than lean on it. So they are bridged for an explicit, greppable seam.

No `PB_DATA`/`PBStore`/`PBImport`, no money/alert code.

## Mechanism

`pb-modals.js` gains `ContributionImportModal` (and its own 3-line doc comment), moved
**verbatim** via a Node line-range slice — never the Edit tool (BOM + literal non-ASCII bytes:
the modal carries literal `·`, `—`, `…`, and curly quotes/apostrophe in the parse-hint copy).
The slice starts at the modal's doc comment (walk back over `//` lines) and ends before the
next top-level `function` (`ImportModal`), asserting the last moved line is `}`. The splice
uses a **replacement function** (inc-13's `$'`-expansion footgun, applied defensively).

Bucket seam edits:
- IIFE gains `const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS;` (PBContent is a global
  loaded before `pb-modals.js`).
- Lead read injected as the first body statement:
  `const { Icon, useSwipeDownToClose, useBodyScrollLock, sanitizeDecimalInput, uid,
  parseCashFlowsFromText, parseCashFlowFile } = window.PBApp;`

`app.js`: the modal def becomes a 3-line pointer comment + `const ContributionImportModal =
PBModals.ContributionImportModal;`; the bridge grows **14 -> 17**
(`+uid, +parseCashFlowsFromText, +parseCashFlowFile`; all `function` decls defined long before
the publish -> TDZ-safe). The invocation at `app.js:5133` is unchanged.

## Wiring

- `sw.js` `CACHE_NAME` **v61 -> v62**. Only shipped-file wiring.
- **Zero** edits to `index.html` / `static.yml` / `SHELL_ASSETS` / the 16 harnesses —
  `pb-modals.js` already wired; `deploy-assets.test.mjs` stays green.
- `architecture-map.html` — docs sync: bridge note **14 -> 17** (`+uid,
  +parseCashFlowsFromText, +parseCashFlowFile`). (The brief expected no arch-map change; it
  follows from the corrected bridge growth.)

## Verification gate

1. `node --check` clean on `app.js` and `pb-modals.js`.
2. Full node suite green; `deploy-assets` green.
3. Anti-drift greps: `function ContributionImportModal` = 0 in app.js / 1 in pb-modals.js; bind
   present; registration present; bridge carries `uid`, `parseCashFlowsFromText`,
   `parseCashFlowFile`; IIFE has `const CURRENCY_SYMBOLS = PBContent.CURRENCY_SYMBOLS;`.
4. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED.**
5. **Render check — `verify-modals.mjs`** (opens the import modal, renders the currency chips
   -> exercises `CURRENCY_SYMBOLS`). A throwaway probe additionally pasted two rows and clicked
   Review to drive `parseCashFlowsFromText` + `uid` at runtime and count the parsed rows,
   closing the coverage gap the committed harness leaves on the paste/parse path.

## Out of scope / deferred

Remaining modals; money/alert modals (rule #3 gated on a characterization test); portals; Vite.

## Commit note

Development on `claude/refactor-plan-next-7cr7q5` (inc-14 stacks on inc-13). Commit + push to the
feature branch; no PR; `main` never pushed. Scratchpad scripts are gitignored.

## Measured read-out (2026-07-14, on execution)

All gates green — 22 node suites (money gate + `deploy-assets` included), mount gate
`verify-refresh-behavior` **ALL PASSED**, and `verify-modals` **CLEAN (exit 0, no page
exception)** after 3 flaky-race retries: the import panel renders at 440x852 with title
"Import deposits & withdrawals"; the throwaway paste probe parsed **2** review rows
(`parseCashFlowsFromText`+`uid` execute through the bridge); literal `· — … ' " ` byte-exact
(no U+FFFD).

**Bucketing economics, measured:**
- `app.js` **-143 lines** net (147-line block [doc comment + modal] -> 4-line pointer+bind),
  `pb-modals.js` **297 -> 447**, `sw.js` **v61 -> v62** (one line). **Zero**
  index/static/harness edits — bucket already wired (`deploy-assets` stayed green). Bucket now
  holds **4** modals.
- **Bridge:** `window.PBApp` grew **14 -> 17** (`+uid, +parseCashFlowsFromText,
  +parseCashFlowFile`, three app.js internals reached via the bridge). `CURRENCY_SYMBOLS` added
  as an IIFE `PBContent.CURRENCY_SYMBOLS` read (a true global, not a bridge member). Not the
  "pure cheap add" the brief predicted — but still no new-file tax.
