# Phase 4 increment 9 — bucket add: extract `HedgesView` into `pb-views.js`

**Date:** 2026-07-12
**Branch:** `refactor/phase-4-increment-9-hedges-view` (stacked off the inc-8 branch HEAD `5e0af7b`, which is inc-8-complete; inc 8 is not yet merged to `main`)
**Status:** design approved by Jan (2026-07-12); awaiting spec review → writing-plans

## Goal

Extract a **third** component — `HedgesView` — into the existing `pb-views.js` bucket, proving the
bucketing thesis's payoff a second time and even more sharply than increment 8: adding a component
to an *already-wired* bucket costs **`app.js`-only edits and zero new `window.PBApp` bridge members**.
Where inc 8 had to grow the bridge 5 → 7 (`+PriceBlock`, `+fmt`) to land `PicksView`, inc 9 grows it
by **nothing** — `HedgesView`'s only app.js-internal dependency, `PriceBlock`, is already bridged.

This is the "near-free follow-up" the inc-8 read-out named. Success = one bucket file
(`pb-views.js`) holding three real view components, all verification gates green, and the bridge
still at 7 members.

## Scope (decided with Jan, 2026-07-12)

- **Component:** `HedgesView` — the "Hedges" tab ([app.js:7960-8007](../../../app.js#L7960), ~48 lines).
  No money mutation; a genuine tab view; dependency set is a strict subset of `PicksView`'s.
  (Chosen as the inc-8 read-out's designated near-free add; `RulesView`/modals remain deferred.)
- **Mechanism:** the existing `window.PBApp` bridge — reused unchanged, **not grown**.
- **The hardcoded "Explicitly skipped" prose list** (TLT / VIXY-UVXY / SH-SPXS / GDXJ) inside
  `HedgesView` **stays in the view, moved byte-verbatim.** Extracting it into `PBContent` (the way
  inc 2 lifted `RulesView`'s prose into `PBContent.RULES`) would touch `pb-content.js` + a new node
  test and break the "near-free, zero-new-surface" property this increment exists to demonstrate.
  Deferred as a possible later content increment. (YAGNI here.)

## Dependency inventory (verified on current `app.js`)

`HedgesView`'s complete external set — an exhaustive scan of its body ([app.js:7960-8007](../../../app.js#L7960)):

| Dependency | Source | Also used elsewhere? | Disposition |
|---|---|---|---|
| `onOpenDetail` | prop | — | unchanged interface (call site [app.js:3443](../../../app.js#L3443)) |
| `PBStore.usePricesMap()` | existing global | — | qualified, no change |
| `DATA.HEDGES` | `window.PB_DATA` (data.js global; `app.js:11` binds `const DATA = window.PB_DATA`) | yes, everywhere | **read `window.PB_DATA` directly** in `pb-views.js` |
| `PriceBlock` | `app.js:3782` React leaf (`React.memo`) | yes — many views | **bridge — already present** (added inc 8); reused, no growth |
| `React.createElement` | UMD global | — | qualified, no change (no hooks used) |

The plain data fields of each hedge (`h.ticker`, `h.allocation`, `h.name`, `h.role`, `h.rationale`)
and the built-in `String`/`Array` methods aside, this is the **complete** set. `HedgesView` uses
**no** React hooks directly (only `PBStore.usePricesMap()`), and — unlike `PicksView` — it does **not**
use `fmt`. Its only app.js-internal dependency is `PriceBlock`, which is already on `PBApp`.

### The bridge does not grow (the sharpened payoff)

`window.PBApp` stays at exactly the 7 members inc 8 left it:
`{ Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt }`. `HedgesView` consumes only
`PriceBlock` from it (a subset of what inc 8 already added for `PicksView`), reaches `DATA` via
`window.PB_DATA` directly, and calls `PBStore` qualified. So the bridge-vs-global split holds with
**zero** new bridge entries — the cleanest possible demonstration that a bucket add, once the bridge
is saturated for a shape, is `app.js`-only.

Concretely, `HedgesView` reaches `DATA` by injecting `const DATA = window.PB_DATA;` as a lead line in
its body (mirroring `app.js:11`), read at render time — by which point `data.js` (loaded after
`pb-views.js`, before render) has set `window.PB_DATA`. The remainder of the body is moved verbatim
(`DATA.HEDGES` unchanged).

## The mechanism — `pb-views.js` after this increment

`pb-views.js` remains one browser-only classic-script IIFE registering each extracted view on
`window.PBViews`. `HedgesView` is spliced in after `PicksView`, before the registration block:

```js
// pb-views.js - extracted view-component bucket (Phase 4). Browser-only classic script.
(function () {
  const { useEffect, useRef } = React; // UMD global; HotTopicsView uses these hooks

  function HotTopicsView(_refHT) { /* … inc 7, unchanged … */ }

  // --- New picks (moved from app.js, Phase 4 inc 8) ---
  function PicksView(_ref9) {
    const { PriceBlock, fmt } = window.PBApp;
    const DATA = window.PB_DATA;
    /* … */
  }

  // --- Hedges (moved from app.js, Phase 4 inc 9) ---
  function HedgesView(_ref0) {
    const { PriceBlock } = window.PBApp;      // app.js internal via bridge (already present)
    const DATA = window.PB_DATA;              // data.js global, read directly
    let { onOpenDetail } = _ref0;
    const prices = PBStore.usePricesMap();
    /* … body moved verbatim from app.js:7960-8007 … */
  }

  window.PBViews = window.PBViews || {};
  window.PBViews.HotTopicsView = HotTopicsView;
  window.PBViews.PicksView = PicksView;
  window.PBViews.HedgesView = HedgesView;
})();
```

**`app.js` changes (the entire footprint):**

1. Replace `function HedgesView(_ref0) { … }` at 7960-8007 with a bind + comment:
   ```js
   // HedgesView is defined in pb-views.js (Phase 4 inc 9); bind it here.
   const HedgesView = PBViews.HedgesView;
   ```
   The `hedges:` `viewMap` entry ([app.js:3443](../../../app.js#L3443)) is built inside `App()`'s
   render body, which runs after every module-scope `const` is initialized — so replacing the hoisted
   function declaration with a `const` bind is TDZ-safe, exactly as the `PicksView` bind already is.
2. **No change to the `window.PBApp` publish line** — the bridge is not grown.

### Extraction discipline (unicode / verbatim)

Move `HedgesView`'s body **verbatim** via a Node line-range splice — never the Edit tool, never
retype. `app.js` has a BOM + CRLF and authors non-ASCII as `\uXXXX`/`\xXX` escapes; `HedgesView`'s
"Explicitly skipped" list uses `—` (em-dash) escapes, which move byte-for-byte. The **only**
edited lines inside the moved body are the two injected lead lines
(`const { PriceBlock } = window.PBApp;` and `const DATA = window.PB_DATA;`). `pb-views.js` keeps its
existing BOM + CRLF; the Node splice reads/writes as `utf8` and joins on `\r\n`.

## Wiring — this is the cost the increment measures

**The extraction (the payoff):** `app.js` only — remove the function, add the bind. Splice
`HedgesView` into `pb-views.js` + one registration line. **Zero** new harness / static.yml /
index.html edits (the bucket file is already fully wired) and **zero** new `PBApp` members.

**The one shipped-asset change:** bump `sw.js` `CACHE_NAME` **`playbook-shell-v56` → `v57`** (re-check
the committed value at execution and bump by one), so installed PWAs don't serve a stale
`pb-views.js`. This is the single wiring edit of the increment.

No worker/wrangler impact (the worker bundles `pb-core`, never view code).
`pb-core`/`pb-data`/`pb-store`/`pb-content`/`pb-import`/`data.js`/`index.html`/`static.yml`/the 16
harnesses are all untouched.

## Verification gate

1. `node --check` clean on `app.js` **and** `pb-views.js`.
2. All existing node suites green (`node backend/test/*.test.mjs`) — money gate unaffected (no money
   code touched). `deploy-assets.test.mjs` stays green (no deploy-asset set change beyond the cache
   bump, which it does not assert on).
3. **Mount gate — `verify-refresh-behavior.mjs` `ALL PASSED`**: app mounts, no `PBViews`/`PBApp`
   ReferenceError; the standing "holdings rows have NO SessionBadge" guard still holds.
4. **Render check (scratchpad, not committed) — the critical one.** `viewMap` builds
   `React.createElement(HedgesView, …)` eagerly every render but only *renders* the `hedges` entry on
   the active tab, so a broken `PBViews.HedgesView` bind yields an `undefined` element **type** the
   mount gate never exercises. A headless check must assert:
   - app mounts;
   - `window.PBViews.HedgesView` is a function (alongside the existing `HotTopicsView`/`PicksView`);
   - `window.PBApp` still has exactly its 7 members and did **not** grow;
   - **Hedges tab renders** — navigate to `button[data-tab="hedges"]` and assert the `.pos-card` grid
     renders with at least one card (proves the extraction is wired). This is the check that actually
     proves correctness;
   - encoding sanity: the moved `—` em-dash in the "Explicitly skipped" list renders without a
     `U+FFFD` replacement char.

## Net effect

- `app.js` ≈ **−46 lines** (HedgesView body removed; +2 lines: bind + comment).
- `pb-views.js` gains ≈ **+50 lines** (HedgesView + its two injected lead lines + one `PBViews`
  registration line).
- Bridge `window.PBApp`: **7 → 7** (unchanged).
- One bucket file now holds **3** view components.
- Changed files: `app.js`, `pb-views.js`, `sw.js` (cache bump only).
- Node suite count unchanged.

## What this increment produces (the deliverable)

Beyond the working extraction, a short measured note (appended to this spec on execution) confirming
the sharpened bucketing economics: the `HedgesView` add cost **0** harness/deploy/index/static edits,
grew `PBApp` by **0**, and touched only `app.js` + `pb-views.js` + a one-line sw bump — i.e., once a
shape's app.js-internals are bridged, each further view of that shape is a pure `app.js`↔bucket move.
This sets the amortized per-component cost for the remaining ~17 components.

## Out of scope / deferred

- **Extracting the "Explicitly skipped" prose to `PBContent`** — a separate content-extraction concern
  (inc-2 pattern); would add `pb-content.js` surface + a test. Deferred.
- **`RulesView` / any remaining simple views** — future bucket adds, one per increment.
- **Any modal** (SellModal/BuyModal/etc.) — modals touch money/alert code and a different
  (`onClose`/portal) shape; out of scope.
- **Pushing pure helpers to `pb-core`** (Approach B), **React Context** (Approach C), **Vite / a build
  step** — all deferred, unchanged from inc 7/8.
- The `demo-data.js` deploy-allowlist gap (GAPS.md #1, tracked separately).

## Commit note

Per Jan's standing rule (2026-06-29): I build on the branch in the working tree; **Jan reviews, PRs,
and merges.** This branch is stacked on the unmerged inc-8 branch — Jan decides the merge ordering
(inc 8 then inc 9, or a combined land). Spec + plan + code are left for Jan; nothing is pushed.
Scratchpad slice scripts and the render-check harness are throwaway — not committed (`scratchpad/` is
now gitignored as of `5e0af7b`).
