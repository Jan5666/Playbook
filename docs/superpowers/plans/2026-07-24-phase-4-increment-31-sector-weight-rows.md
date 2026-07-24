# Phase 4 · Increment 31 — plan (turnkey recipe)

Target: move `SectorWeightRows` from `app.js` into `pb-modals.js` beside its only two callers
(`SectorAllocationModal`, `PositionModal`) and drop it from the `window.PBApp` bridge. See the
design doc for the dependency inventory.

1. **Inventory** — done (design doc). Only bridge change: **remove** `SectorWeightRows` (44 → 43).
   No new bridge members. One render-time read introduced in the moved body (`DATA`).
2. **Verbatim move** — Node slice script (BOM + LF safe; read `utf8`, split/join `\n`, keep BOM,
   splice by content-anchored index). Anchor on:
   - `function SectorWeightRows({ rows, setRows }) {` → first following bare `}`.
   - Insert into `pb-modals.js` immediately before the `SectorAllocationModal` doc-comment
     (`// Dedicated "edit just the sector allocation" modal …`).
3. **Lead reads** — inject as the moved function's first two body statements:
   `const { Icon } = window.PBApp;` and
   `const DATA = window.PB_DATA; // data.js loads after this bucket - read at render time`.
4. **Bridge + callers** — remove `SectorWeightRows` from the `window.PBApp = { … }` publish line;
   drop it from the two `window.PBApp` lead-read destructures in `pb-modals.js`
   (`SectorAllocationModal` line ~31, `PositionModal` line ~3333). Replace the app.js function body
   with a pointer comment; remove the now-stale "Shared editor …" description block above it. **No**
   `window.PBModals` registration (no external consumer).
5. **Wiring** — `sw.js` `CACHE_NAME` v81 → v82 (only shipped-file change; bucket already wired). No
   `PBContent`/`PBData`/`PBCore` bind left app.js, so no delegation/anti-inline guard changes; no
   test references `SectorWeightRows`.
6. **Docs** — `architecture-map.html` (member list: −SectorWeightRows; count 44 → 43; inc-31
   narrative clause), `REFACTOR_STATUS.md` Done + Current-state + branch header, this spec+plan pair.

## Verification (all green before commit)

- `node --check app.js && node --check pb-modals.js`.
- Full node suite incl. **money gate** (`money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse`):
  `for f in backend/test/*.test.mjs; do node "$f" || break; done`.
- Anti-drift greps: `function SectorWeightRows` = 0 app.js / 1 pb-modals.js; absent from the
  `window.PBApp` publish line; `React.createElement(SectorWeightRows` = 0 app.js / 2 pb-modals.js.
- **Mount gate**: `verify-refresh-behavior.mjs` (scratchpad-patched copy: `ROOT=/home/user/Playbook`,
  local React via `/__react.js`+`/__react-dom.js`, `--no-sandbox`, `CHROME_PATH=/opt/pw-browsers/chromium`).
- **Render probe** (throwaway): open `SectorAllocationModal`; assert `.sector-split-*` rows +
  "Add sector" button render and the `DATA.SECTOR_CANON` `<option>`s populate. No money side-effects.
- U+FFFD scan over `app.js` + `pb-modals.js`.

## Landing

Branch `claude/refactor-plan-xv8lkg` (off latest `origin/main`). Commit
`refactor(modal): relocate SectorWeightRows into pb-modals.js (inc 31)`; push
`git push -u origin claude/refactor-plan-xv8lkg`. **No PR, never `main`** — Jan reviews and lands.
