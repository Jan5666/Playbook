# Phase 4 increment 10 — extract RulesView + OverviewView into `pb-views.js` — Implementation Plan

**Goal:** Move `ruleSection` + `RulesView` + `OverviewView` verbatim from `app.js` into the
existing `pb-views.js` bucket, growing the `window.PBApp` bridge by exactly one member
(`THESIS_SNAPSHOT`). App green at every step; the only wiring is `app.js` + `pb-views.js` +
one `sw.js` cache bump.

**Branch:** `claude/refactor-plan-next-tbupah` (off `origin/main` `763aced`).

## Global constraints

- **Verbatim move via a Node slice script — never the Edit tool.** `app.js`/`pb-views.js`
  carry a leading BOM; OverviewView authors `→`/`—` as `\uXXXX` escapes. **This checkout
  stores both files LF** (`git ls-files --eol` → `i/lf w/lf`; no `.gitattributes`) — the
  script reads/writes `'utf8'` and splits/joins on `'\n'` (verify EOL before running; the
  older docs' CRLF claim is stale here).
- **Bridge grows by one.** `window.PBApp` goes 7 → 8 (`+THESIS_SNAPSHOT`). RulesView needs
  none; OverviewView needs `PriceBlock` (already present) + `THESIS_SNAPSHOT` (new).
- **Globals read directly, internals via the bridge.** In the moved views: `PBContent.RULES`,
  `window.PB_DATA`, `PBStore.usePricesMap()` are read directly; only `PriceBlock`/
  `THESIS_SNAPSHOT` come from `window.PBApp`.
- **Load order unchanged:** `pb-views.js` keeps its slot (after `pb-import.js`, before
  `data.js`/`app.js`); views read `window.PBApp`/`PB_DATA`/`PBContent` lazily at render.

## Task 1 — extract the three defs + grow the bridge + bump sw cache

**Files:** `app.js` (remove `ruleSection`+`RulesView`+`OverviewView` → comment + 2 binds;
grow bridge), `pb-views.js` (splice in the 3 defs + 2 registrations), `sw.js` (cache bump).
Throwaway: `scratchpad/inc10-extract-rules-overview.mjs`.

Slice-script outline (markers, all ASCII, all unique — verified):
- app.js: slice `[function ruleSection( … function OverviewView( … )` up to
  `function PriceChart(_refChart)`; split into ruleSection / RulesView / OverviewView blocks.
- Inject lead reads after each signature: RulesView `const RULES = PBContent.RULES;` +
  `const DATA = window.PB_DATA;`; OverviewView
  `const { PriceBlock, THESIS_SNAPSHOT } = window.PBApp;` + `const DATA = window.PB_DATA;`.
- Replace the app.js span with the comment + `const RulesView = PBViews.RulesView;` +
  `const OverviewView = PBViews.OverviewView;`.
- Grow bridge: exact-line replace
  `window.PBApp = { …, PriceBlock, fmt };` → `{ …, PriceBlock, fmt, THESIS_SNAPSHOT };`.
- pb-views.js: insert the 3 blocks before the `window.PBViews = window.PBViews || {}` block;
  add `window.PBViews.RulesView`/`.OverviewView` registrations after the HedgesView one.
- sw.js: single-line `CACHE_NAME` bump (re-check current value first; `v57` → `v58`).

Then: `node --check app.js && node --check pb-views.js`; confirm BOM/EOL preserved.

## Task 2 — verify

1. Full node suite (`for f in backend/test/*.test.mjs; do node "$f"; done`) — all `ok`.
2. Anti-drift greps (see spec §Verification gate 3).
3. **Mount gate:** `verify-refresh-behavior.mjs` → `ALL PASSED`.
4. **Render check (scratchpad, not committed):** Rules + Overview tabs render; `→`/`—` no
   U+FFFD; `PBApp` = 8 members; Picks sibling still renders.

> **Container note (this environment only):** the `verify-*.mjs` harnesses hardcode a Windows
> Chrome path and load React from unpkg. Here, set `CHROME_PATH=/opt/pw-browsers/chromium`,
> run Chromium with `--no-sandbox` (root), and serve React from a local npm copy
> (`npm i react@18.3.1 react-dom@18.3.1` in scratchpad — unpkg is egress-blocked). A
> throwaway patcher (`scratchpad/patch-harness.mjs`) applies these to a scratchpad copy so the
> committed harnesses stay untouched. On Jan's machine the harnesses run unmodified.

## Task 3 — measured read-out + docs

Append the measured read-out to the spec (app.js/pb-views.js deltas, bridge = 8, bucket = 5,
sw version). Commit code + docs to the branch; push. No PR; never `main`.

## Self-review

- Goal/scope → Task 1.
- Dependency inventory (ruleSection moves; RULES/DATA/PBStore direct; PriceBlock+THESIS_SNAPSHOT
  bridged) → Task 1 injects, Task 2 greps verify.
- Bridge +1 only → exact-line replace + render-check `Object.keys(PBApp).length === 8`.
- Wiring minimal (app.js + pb-views.js + sw bump; zero harness/index/static) → Task 1;
  `deploy-assets` green confirms.
- Encoding (LF + BOM + `\uXXXX` verbatim) → Global constraints + render-check U+FFFD assertion.
- Out-of-scope (no modal, no big view, no pb-core push, no Context, no Vite) → honored.
