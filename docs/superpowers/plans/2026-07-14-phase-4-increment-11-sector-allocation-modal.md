# Phase 4 increment 11 — extract `SectorAllocationModal` into new `pb-modals.js` — Implementation Plan

**Goal:** Move `SectorAllocationModal` verbatim from `app.js` into a **new** `pb-modals.js`
bucket, grow the `window.PBApp` bridge by three members (`useSwipeDownToClose`,
`useBodyScrollLock`, `SectorWeightRows`), and pay the new-runtime-file wiring tax once. App
green at every step. `SectorWeightRows` **stays** in `app.js` (second caller: the position
editor at `app.js:10749`).

**Branch:** `claude/refactor-plan-next-7cr7q5` (off `origin/main` `3c74696`).

## Global constraints

- **Verbatim move via a Node slice script — never the Edit tool.** `app.js`/`pb-modals.js`
  carry a leading BOM; the modal subtitle authors `·` as a literal U+00B7 byte
  (`c2 b7`). This checkout stores files **LF** with a BOM; the script reads/writes `'utf8'`
  (BOM rides along) and splits/joins on `'\n'`. `pb-modals.js` gets a BOM prepended
  (`String.fromCharCode(0xFEFF)`) to match `pb-views.js`.
- **Bridge grows by three.** `window.PBApp` 8 → 11. All three new members are defined before
  the publish line (hooks at 230/300, `SectorWeightRows` at 4352) → TDZ-safe; each is read
  inside the moved component body, not at module top.
- **Globals read directly, internals via the bridge.** `SectorAllocationModal` reads no
  `PB_DATA`/`PBStore`/`PBContent`; everything is a React hook or a bridge member.
- **Load order:** `pb-modals.js` slots after `pb-import.js`/`pb-views.js`, before
  `data.js`/`app.js`.

## Task 1 — extract the modal into a new file + grow the bridge + bump sw cache

**Files:** `app.js` (remove `SectorAllocationModal` → pointer comment + 1 bind; grow bridge;
leave `SectorWeightRows`), new `pb-modals.js`, `sw.js` (SHELL_ASSETS + cache bump).
Throwaway: `scratchpad/inc11-extract.mjs`.

Slice-script outline (markers, all ASCII, all unique — verified):
- Locate the block `[Dedicated "edit just the sector allocation" comment … function
  SectorAllocationModal … closing }]`, bounded above the `Donut palettes` comment.
- Build `pb-modals.js`: BOM + header + `(function () { const { useState, useRef } = React;`
  + the moved block with `const { Icon, useSwipeDownToClose, useBodyScrollLock,
  SectorWeightRows } = window.PBApp;` injected as the first body statement +
  `window.PBModals.SectorAllocationModal = SectorAllocationModal;` + IIFE close.
- Replace the app.js span with the pointer comment + `const SectorAllocationModal =
  PBModals.SectorAllocationModal;`.
- Grow bridge: exact-line replace `window.PBApp = { …, THESIS_SNAPSHOT };` →
  `{ …, THESIS_SNAPSHOT, useSwipeDownToClose, useBodyScrollLock, SectorWeightRows };`.
- `sw.js`: `SHELL_ASSETS` entry after `./pb-views.js`; `CACHE_NAME` `v58 → v59`.

Then: `node --check app.js && node --check pb-modals.js`; confirm BOM/EOL + literal `·`
preserved.

## Task 2 — pay the new-file wiring tax (index.html / static.yml / 16 harnesses / map)

- `index.html`: `<script src="./pb-modals.js">` after `pb-views.js`.
- `.github/workflows/static.yml`: add `pb-modals.js` to the `cp` list **and** the Guard-1 loop.
- **16 `verify-*.mjs`** harnesses: a throwaway script (`scratchpad/inc11-wire-harnesses.mjs`)
  clones each harness's `pb-views.js` script line as `pb-modals.js` (idempotent; preserves
  indent/prefix/EOL). Glob + filter to those embedding the tag → hits exactly the 16.
- `architecture-map.html`: docs sync — load-chain note + the 11-member bridge.

## Task 3 — verify

1. Full node suite (`for f in backend/test/*.test.mjs; do node "$f"; done`) — all `ok`;
   **`deploy-assets.test.mjs` green** is the decisive proof the new file is wired consistently.
2. Anti-drift greps (see spec §Verification gate 3).
3. **Mount gate:** `verify-refresh-behavior.mjs` → `ALL PASSED`.
4. **Render check:** `verify-sector-weights.mjs` → the "Sector allocation" modal opens scoped
   to VOO with 3 seeded rows + running total; subtitle `VOO · …` renders (no U+FFFD).

> **Container note (this environment only):** `CHROME_PATH=/opt/pw-browsers/chromium` (the
> harness honors it), `--no-sandbox`, and a locally-`npm i`'d React served via injected routes
> (unpkg is egress-blocked, 403) — applied to throwaway **scratchpad copies**
> (`scratchpad/patch-harness.mjs`) so the committed harnesses stay untouched. On Jan's machine
> they run unmodified.

## Task 4 — measured read-out + docs

Append the measured read-out to the spec (app.js/pb-modals.js deltas, bridge = 11, bucket = 1,
sw v59). Commit code + docs to the branch; push. No PR; never `main`.

## Self-review

- Goal/scope → Tasks 1–2.
- Dependency inventory (`SectorWeightRows` stays — 2nd caller; hooks + `SectorWeightRows`
  bridged; `Icon` already bridged) → Task 1 injects, Task 3 greps verify.
- Bridge +3 only → exact-line replace + anti-drift grep.
- Wiring (new file → full tax: index/sw/static/16 harnesses/map) → Task 2; `deploy-assets`
  green confirms.
- Encoding (LF + BOM + literal `·` verbatim) → Global constraints + render-check U+FFFD check.
- Out-of-scope (no other modal, no money/alert code, no portal, no Vite) → honored.
