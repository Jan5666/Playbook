# Phase 4 increment 17 — sixth modal: `SettingsModal` (+ `TabReorderList`) -> `pb-modals.js`

**Date:** 2026-07-14
**Branch:** `claude/refactor-plan-continuation-fm72ce` (stacks on inc-16)
**Status:** design approved (plan mode) — chosen as the safest large modal (senior-dev prioritization)

## Goal

Move the settings dialog `SettingsModal` (`app.js:9945–10580`) together with its single-caller
sub-component `TabReorderList` (`app.js:9804–9944`) into the `pb-modals.js` bucket — a contiguous
**777-line block (9804–10580)**. Biggest safe `app.js` reduction remaining.

**Why this is safe (the overriding constraint: no functional regression).** Read-verified: the
modal body has **no cost-basis math, no `evalAlert`/`marketOpen`, no import-matching, no crypto** —
the lone `costBasis` ref is a display fallback and the "encrypted" strings are UI copy. Money shows
via `computeFxSnapshot`/`convertCcy`/`fmt` (helpers that **stay** in app.js/PBCore); backup, restore,
export/import, push are **delegated to props** (`cloudBackup.restore(...)`, `onExport`, `onImport`,
`onConnectPush`, …). Settings I/O is `PBStore.setSetting`/`useSetting` (free global). So the move
touches **no rule-#3 (money/alert) and no rule-#5 (backup-format) code** — it relocates a display
component only.

## Dependency inventory (every free identifier classified, on `app.js` @ post-inc-16)

Block renders only `Icon` + native HTML (no other app.js component). Only module namespace used
directly is `PBStore` (27×, free global). `computeFxSnapshot` (9680) is **shared** (dashboard
@4976) -> stays, bridged. `FxSummary` (9736) has **no callers** — vestigial; left in app.js and
flagged (not deleted).

### Reaches app.js internals -> bridge (`window.PBApp`), **23 -> 31 (+8)**

| Symbol | Kind | Used by | callers outside block |
|---|---|---|---|
| `Icon`, `fmt`, `useBodyScrollLock` | leaf/helper/hook | both / Settings | already bridged |
| `computeFxSnapshot` | fn (FX display) | Settings | shared (dashboard) -> **new** |
| `formatCode`, `normalizeCode` | fn (currency-code) | Settings | shared -> **new** |
| `positionDisplayName` | fn | Settings | shared (4×) -> **new** |
| `DEFAULT_TAB_ORDER` | data const | Settings | shared (2×) -> **new** |
| `MARKET_LABELS` | data const | Settings | shared (5×) -> **new** |
| `TAB_ALWAYS_VISIBLE` | data const | both | shared (2×) -> **new** |
| `TAB_LABELS` | data const | TabReorderList | shared (2×) -> **new** |

### Reads module globals -> IIFE (**4 new**)

| Symbol | Source | Note |
|---|---|---|
| `convertCcy`, `priceKey`, `CURRENCY_SYMBOLS` | PBCore/PBContent | already IIFE reads (inc-14/15) |
| `DISPLAY_CURRENCIES` | `PBContent.DISPLAY_CURRENCIES` | **new** IIFE read (app.js bind stays — used 3× outside) |
| `MARKETS` | `PBContent.MARKETS` | **new** IIFE read (bind stays — 8× outside) |
| `RIBBON_CATALOG` | `PBContent.RIBBON_CATALOG` | **new** IIFE read (bind stays — 2× outside) |
| `useLayoutEffect` | `React` | **new** — add to the IIFE React destructure (TabReorderList drag/FLIP) |

Because the three `PBContent` binds **stay** in app.js, the `content.test.mjs` delegation guard is
**unaffected** (unlike inc-16's `SECTOR_FWD_PE`). No test change.

### Free globals / block-local

`PBStore.*`, `React`, `URL`, `Math`, `navigator.clipboard`, `window.confirm`, `document` — verbatim.
Block-local (move with the block): `TabReorderList`, `holdingValue`, `captureTops`, `liftTransform`,
`onHandleDown`, `toggleDel`, `toggleDelMarket`, all state/closures. `bezier`/`scale`/`translateY` are
CSS-in-strings; `restore` is `cb.restore()` (prop method).

## Mechanism

Node line-range slice (**never the Edit tool** — BOM + LF; body carries literal `– — · £ € "` and
curly quotes). Slice `9804–10580`; assert first line is `function TabReorderList(` and last is `}`
(SettingsModal close), and the next app.js line is the inc-15 `AlertsModal`/`Import` neighbourhood.
Splice with a replacement function.

Into `pb-modals.js` (inserted before the existing subtree/DetailModal, hoisting makes order moot):
- **2 per-component render-time lead reads** as each component's first body statement:
  - `TabReorderList`: `const { Icon, TAB_ALWAYS_VISIBLE, TAB_LABELS } = window.PBApp;`
  - `SettingsModal`: `const { Icon, fmt, useBodyScrollLock, computeFxSnapshot, formatCode,
    normalizeCode, positionDisplayName, DEFAULT_TAB_ORDER, MARKET_LABELS, TAB_ALWAYS_VISIBLE } =
    window.PBApp;`
- IIFE: add `useLayoutEffect` to the React destructure; add the 3 `PBContent` reads.
- Register `window.PBModals.SettingsModal`.

In `app.js`: block -> pointer comment + `const SettingsModal = PBModals.SettingsModal;`; bridge
publish (line 10638) grows **+8** (all defined before the publish -> TDZ-safe). The invocation at
`app.js:3553` (`React.createElement(SettingsModal, {...})`) is unchanged. `computeFxSnapshot` +
`FxSummary` stay.

## Wiring

- `sw.js` `CACHE_NAME` **v64 -> v65**. Only shipped-file wiring.
- **Zero** edits to index.html/static.yml/SHELL_ASSETS/16 harnesses — bucket already wired;
  `deploy-assets` stays green.
- `architecture-map.html` — bridge note **23 -> 31** + member-list edit; add SettingsModal to the
  bucket description.

## Verification gate

1. `node --check` app.js + pb-modals.js.
2. Full node suite (**22**; **money gate** unaffected — display only; **content guard** unchanged;
   `deploy-assets` green).
3. Anti-drift greps: `function SettingsModal`/`TabReorderList` = 0 app.js / 1 pb-modals.js; bridge
   carries the 8 new members; `computeFxSnapshot`/`FxSummary` still defined once in app.js (stayed);
   3 PBContent IIFE reads + `useLayoutEffect` present.
4. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED** (patched scratchpad copy).
5. **Settings render probe** (throwaway): open Settings via `button[aria-label="Settings"]`; assert
   `.settings-dialog` renders, section nav switches (display/data/…), the FX summary + display-
   currency control render (bridged `computeFxSnapshot`/`convertCcy`/`fmt`), the backup/restore
   **UI** and the **`TabReorderList`** render (uses `TAB_LABELS`/`TAB_ALWAYS_VISIBLE` + `useLayoutEffect`)
   — **without** triggering destructive backup/delete/restore. U+FFFD scan.

## Out of scope / deferred

`FxSummary` dead-code cleanup; the rule-#3-gated money/alert modals (Sell/Buy/Alerts —
characterization test first); Import/Position; Vite.

## Commit note

Development on `claude/refactor-plan-continuation-fm72ce`; commit + push to the feature branch.
**No PR; `main` never pushed.** Scratchpad scripts gitignored.

## Measured read-out (2026-07-14, on execution)

All gates green. 22 node suites (money gate + **content guard 14/0** + `deploy-assets`); mount gate
`verify-refresh-behavior` **ALL PASSED** (one earlier run showed a lone timing-flake failure — the
harness never opens Settings and `SettingsModal` is lazy, so the move can't affect it; a clean re-run
confirmed). Settings render probe **PROBE ALL PASSED** first try:
- `.settings-dialog` renders — SettingsModal's 10-member lead read + the on-open `computeFxSnapshot`
  memo resolve without throwing; **9** section-nav items; display-currency `<select>` (DISPLAY_CURRENCIES
  IIFE read).
- FX Rates section renders (bridged `computeFxSnapshot`/`convertCcy`, no throw).
- **`TabReorderList` renders `.tab-config-list` with 10 rows** — its lead read (`Icon`,
  `TAB_ALWAYS_VISIBLE`, `TAB_LABELS`) + the new `useLayoutEffect` work.
- Data/backup section renders (no destructive backup/restore/delete triggered); **0** U+FFFD.

**Bucketing economics, measured:**
- `app.js` **10640 -> 9866 (-774)** (776-line block -> 2-line pointer+bind), `pb-modals.js`
  **1523 -> 2307 (+784)** (block + 2 lead reads + 4 IIFE reads + header + registration), `sw.js`
  **v64 -> v65**. **Zero** index/static/harness edits (bucket already wired; `deploy-assets` green).
- **Bridge 23 -> 31 (+8):** 4 shared helper fns (`computeFxSnapshot`, `formatCode`, `normalizeCode`,
  `positionDisplayName`) + 4 shared data consts (`DEFAULT_TAB_ORDER`, `MARKET_LABELS`,
  `TAB_ALWAYS_VISIBLE`, `TAB_LABELS`) — all genuinely shared (callers outside the block), so correctly
  stay in app.js and are bridged. `computeFxSnapshot` (dashboard-shared) and vestigial `FxSummary`
  stayed. +4 IIFE reads (`useLayoutEffect` + PBContent `DISPLAY_CURRENCIES`/`MARKETS`/`RIBBON_CATALOG`,
  whose app.js binds stayed -> **content guard untouched**, unlike inc-16).
- **Rule #3/#5 honored:** no cost-basis math, alert eval, import-matching, or backup-format/crypto code
  moved — money shows via bridged/IIFE display helpers; backup/push/export/import stay delegated to
  props. The probe pins Settings + FX + backup-UI render without side-effects.

**Conclusion:** the largest safe modal is extracted; the bucket holds 6 modals + the detail subtree +
the settings subtree; bridge at 31. Remaining Phase-4 modal tier is the rule-#3-gated money/alert
modals (Sell/Buy/Alerts — characterization test first) plus Import/Position.
