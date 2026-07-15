# Phase 4 increment 17 — extract `SettingsModal` (+ `TabReorderList`) — Implementation Plan

**Goal:** Move the 777-line block `app.js:9804–10580` (`TabReorderList` + `SettingsModal`) into
`pb-modals.js`. Bridge **23 -> 31** (+8 shared helpers/consts); +4 IIFE reads (3 PBContent +
`useLayoutEffect`). Safe display-only move — no rule-#3/#5/MONEY-GATE code.

**Branch:** `claude/refactor-plan-continuation-fm72ce` (stacks on inc-16).

## Constraints

- **Node slice, never Edit tool.** BOM + LF; literal `– — · £ € "` + curly quotes. Replacement-fn splice.
- **Bridge +8:** `computeFxSnapshot, formatCode, normalizeCode, positionDisplayName, DEFAULT_TAB_ORDER,
  MARKET_LABELS, TAB_ALWAYS_VISIBLE, TAB_LABELS` — all defined before the publish (line 10638) -> TDZ-safe.
- **IIFE +4:** `useLayoutEffect` (React destructure), `DISPLAY_CURRENCIES`/`MARKETS`/`RIBBON_CATALOG`
  (PBContent). The PBContent binds **stay** in app.js -> `content.test.mjs` guard unchanged.
- **2 lead reads:** TabReorderList `{Icon, TAB_ALWAYS_VISIBLE, TAB_LABELS}`; SettingsModal
  `{Icon, fmt, useBodyScrollLock, computeFxSnapshot, formatCode, normalizeCode, positionDisplayName,
  DEFAULT_TAB_ORDER, MARKET_LABELS, TAB_ALWAYS_VISIBLE}`.
- `computeFxSnapshot` (9680) + `FxSummary` (9736, vestigial) **stay** in app.js.

## Task 1 — move block + inject lead reads + grow bridge + IIFE reads + register + bump sw

Files: `app.js` (block -> pointer+bind; bridge +8), `pb-modals.js` (block + 2 lead reads + 4 IIFE reads
+ registration), `sw.js` (v64 -> v65). Throwaway `scratchpad/inc17-extract.mjs`.

Slice: `function TabReorderList(` .. line before `function SellModal(`? No — after SettingsModal comes
`InstallBanner`. End = line before `function InstallBanner(`. Assert last moved line is `}`.
Inject the 2 lead reads after each signature (SettingsModal signature spans 4 lines — inject after the
closing `}) {` of its destructured params). Insert block before the inc-16 subtree header in pb-modals.js.
`node --check` both.

## Task 2 — docs

`architecture-map.html`: bridge 23 -> 31 + member list; SettingsModal in bucket description.

## Task 3 — verify

Node suite (money gate + content guard + deploy-assets) green; anti-drift greps; mount gate
`verify-refresh-behavior` ALL PASSED; **Settings render probe** (open Settings, assert `.settings-dialog`
+ sections + FX summary + TabReorderList render, no destructive actions, U+FFFD scan).

## Task 4 — read-out + progress doc + commit

Append read-out to spec. Create `docs/superpowers/REFACTOR_STATUS.md`; refresh CLAUDE.md "Current state".
Commit + push. **No PR; never `main`.**

## Self-review

- Scope (TabReorderList single-caller moves; computeFxSnapshot/FxSummary stay) -> verified.
- Inventory complete (8 bridge + 4 IIFE; PBStore free-global; block-local closures) -> anti-drift greps.
- SettingsModal 4-line signature -> inject lead read after the params close, not after line 1.
- Rule #3/#5 (no money/backup code moves; delegated via props) -> render probe pins Settings render.
- Encoding (£ € · – — ") -> U+FFFD scan.
