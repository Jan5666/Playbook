# Phase 4 increment 7 — first component split: HotTopicsView → pb-view-hot.js (no-build spike)

**Date:** 2026-07-11
**Branch:** `refactor/phase-4-increment-7-hottopics-view` (off origin/main `f2028f1`)
**Status:** design approved by Jan; awaiting spec review → writing-plans

## Goal

Extract exactly **one** React component — `HotTopicsView` — out of `app.js` into its own
no-build global script, establishing the reusable pattern by which an extracted global-script
component reaches shared `app.js` internals it cannot `import`. This is a **spike**: its purpose
is to make the true cost of a component split concrete (wiring tax + prop-drilling +
shared-dependency access) so the deferred **Vite-vs-no-build** decision can be made with data
rather than speculation.

Increments 1–6 extracted pure *content/logic* (data tables, parsers, money math) into dual-mode
shared modules. Splitting a *component* is categorically different: it is React UI (hand-written
`React.createElement`, no JSX) that closes over `App()` props and reaches shared leaf components
and helpers. This increment is the first to cross that line, deliberately at the smallest honest
scale.

## Scope (decided with Jan)

**Build-step decision (Jan, 2026-07-11):** *No-build spike first.* Keep the global-script model
for this increment; extract one component the current way, measure the cost, then decide on Vite
later with real data. No bundler introduced here.

**Spike target (Jan, 2026-07-11):** `HotTopicsView` — a whole tab view (~136 lines, app.js
`8487`–`8622` on origin/main `f2028f1`). Chosen over `RulesView` (too trivial — measures only the
fixed wiring tax) and `SellModal` (under-measures view-level coupling) because it exercises **all
three** costs: fixed wiring tax, prop-drilling (6 props from `App`), and shared-dependency access
(the `Icon` leaf + three shared pure helpers).

**Shared-dependency mechanism (Jan, 2026-07-11): Approach A — app-runtime bridge (`window.PBApp`).**
See "The mechanism" below. Approaches B (push pure helpers down to `pb-core`) and C (React Context)
were considered and deferred — B expands the spike with helper relocations + tests and *still*
needs an `Icon` bridge; C adds provider/`useContext` ceremony and changes how every future
component receives deps.

## Dependency inventory (verified on `f2028f1`)

`HotTopicsView`'s non-React, non-prop dependencies split cleanly into "move with the view" vs
"bridge":

| Dependency | app.js line | Kind | Also used elsewhere? | Disposition |
|---|---|---|---|---|
| `HOT_TAG_LABEL` | 8477 | const map | No (only the view) | **move** into `pb-view-hot.js` |
| `hotCountdown` | 8481 | pure fn | No (only the view) | **move** into `pb-view-hot.js` |
| `Icon` | 1321 | React leaf component | Yes — 139 uses across app.js | **bridge** (stays in app.js) |
| `timeAgo` | 1237 | pure helper | Yes — DetailModal, AlertsModal | **bridge** (stays in app.js) |
| `hotToDate` | 965 | pure helper | Yes — hot-topics loader (~965–1114) | **bridge** (stays in app.js) |
| `hotDayDiff` | 973 | pure helper | Yes — hot-topics loader | **bridge** (stays in app.js) |
| `prettyName` | 6075 | pure helper | Yes — 11 uses (Holdings, watchlist, TFSA, DetailModal) | **bridge** (stays in app.js) |
| `PBStore.usePricesMap()` | — | existing global | — | already reachable (qualified), no change |
| React / `useEffect` / `useRef` | — | UMD global | — | reachable; IIFE destructures the two hooks from `React` |

The exhaustive body scan (every called identifier in `8487`–`8622`) confirms this is the **complete**
external set: JS built-ins (`Date`/`String`) and prototype methods aside, the view calls only
`timeAgo`, `hotToDate`, `hotDayDiff`, `hotCountdown`, `prettyName`, `Icon`, `PBStore.usePricesMap`,
`useEffect`/`useRef`, and its props (`onOpenDetail`, `toast`, `onLoad`, `perplexityKey`,
`onOpenAlerts`). Nothing else.

`timeAgo`/`hotToDate`/`hotDayDiff` **cannot** simply move with the view: they are also called by
the App-side hot-topics loader and other modals. They therefore stay in `app.js` and are reached
through the bridge. `HOT_TAG_LABEL`/`hotCountdown` are view-local and move with the view.

**Props (unchanged interface):** `HotTopicsView` is invoked in `App()`'s `viewMap` as
`hot: React.createElement(HotTopicsView, { hot, onLoad, onOpenDetail, perplexityKey, onOpenAlerts,
toast })`. That call site and the prop set are **unchanged** by this increment.

## The mechanism — Approach A, app-runtime bridge

The existing convention is "shared module provides a global; `app.js` binds `const X = PBX.X` at
the old def site." A component split needs the **reverse** direction too — the extracted view
needs things *from* `app.js`. Approach A adds exactly that reverse bridge, resolved lazily at
render time so load order is a non-issue.

**1. New file `pb-view-hot.js`** (browser-only classic script; no CommonJS/dual-mode — a pure-UI
view has no pure surface to node-test, and is verified by browser smoke instead):

```js
(function () {
  const { useEffect, useRef } = React; // UMD global; view uses these hooks unqualified
  const HOT_TAG_LABEL = { /* … moved verbatim from app.js:8477 … */ };
  function hotCountdown(diff) { /* … moved verbatim from app.js:8481 … */ }

  function HotTopicsView(_refHT) {
    // Reach shared app.js primitives at CALL time (App has published PBApp before render):
    const { Icon, timeAgo, hotToDate, hotDayDiff, prettyName } = window.PBApp;
    const prices = PBStore.usePricesMap();
    /* … body moved verbatim from app.js … */
  }

  window.PBViews = window.PBViews || {};
  window.PBViews.HotTopicsView = HotTopicsView;
})();
```

`window.PBViews` is a namespace object that future extracted views/modals augment (one property
each), so `app.js` can bind `const { HotTopicsView } = PBViews`.

**2. `app.js` — publish the bridge.** At module scope, before `root.render(...)`, add:

```js
window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName };
```

This is the single, reusable bridge; future splits add members as needed. It is populated before
first render (placed just before `ReactDOM.createRoot(...)` at app.js `12312`, by which point all
five members — the `Icon` const at `1321` and the four helpers — are defined), and the view reads
it inside its body (call-time), so it is TDZ-safe exactly like the existing `const X = PBCore.X`
binds. Only the five members `HotTopicsView` actually needs are exported this increment (no
speculative additions — YAGNI).

**3. `app.js` — replace the definition with a bind.** At the old def site (`8487`), replace
`function HotTopicsView(_refHT) { … }` (and the two now-moved consts `HOT_TAG_LABEL`/`hotCountdown`
at `8477`/`8481`) with:

```js
const HotTopicsView = PBViews.HotTopicsView;
```

The `viewMap` usage in `App()` is unchanged.

### Extraction discipline (unicode / verbatim)

Move the view body + the two consts **verbatim** (line-range copy, do not retype) — `app.js` has a
BOM + CRLF and authors `·`/`£`/`—` etc. as `\uXXXX` escapes; retyping mangles them. The view body
contains the string `'Updated '` + `timeAgo(...)` and section labels; check for any literal
non-ASCII in the moved span and, if present, use a Node line-range splice rather than the Edit tool
(per CLAUDE.md gotchas). The only *edited* line inside the moved body is prepending the
`const { Icon, timeAgo, hotToDate, hotDayDiff } = window.PBApp;` destructure.

## Wiring (this **is** the cost the spike measures)

A brand-new runtime file requires the full checklist (CLAUDE.md "wiring checklist"):

1. **`index.html`** — `<script src="./pb-view-hot.js">` in load order. Place it **after
   `pb-import.js`, before `data.js`** (grouped with the other `pb-*` scripts; it references nothing
   at module-load time except `React`/`PBStore`, both loaded earlier, and reads `PBApp` lazily). It
   must load **before `app.js`** so `app.js`'s `const HotTopicsView = PBViews.HotTopicsView`
   module-scope bind resolves.
2. **`sw.js`** — add `pb-view-hot.js` to `SHELL_ASSETS`; **bump `CACHE_NAME` v51 → v52**.
3. **`.github/workflows/static.yml`** — add `pb-view-hot.js` to **both** the `cp` allowlist **and**
   the Guard-1 loop.
4. **All 16 app-mounting `verify-*.mjs` harness shells** — each embeds its own `<script>` list; add
   `<script src="/pb-view-hot.js">` after `pb-import.js` in every one. (The pure-unit
   `content.test.mjs` etc. have no shell — 16 harnesses, matching inc 4/5's count.)

No worker/wrangler impact (the worker bundles `pb-core`, never view code). `pb-core`/`pb-data`/
`pb-store`/`pb-content`/`pb-import`/`data.js` are untouched.

## Verification gate

Component splits are **not** covered by node suites (nothing pure moved; node never loads app.js
in a browser). The gate is therefore:

1. `node --check` clean on `app.js` **and** `pb-view-hot.js`.
2. All existing node suites still green (`node backend/test/*.test.mjs`) — unchanged, confirms no
   collateral breakage. Money gate unaffected (no money code touched).
3. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED** after its shell gains the new script:
   app mounts, no `PBViews`/`PBApp` ReferenceError; the standing "holdings rows have NO
   SessionBadge" guard still holds.
4. **Hot-tab render check (the critical one).** `viewMap` builds
   `React.createElement(HotTopicsView, …)` eagerly every render, but only *renders* the `hot`
   entry when the Hot tab is active — so a broken `PBViews.HotTopicsView` bind yields an `undefined`
   element **type** that the mount gate does not exercise. A **scratchpad headless check**
   (not committed, same pattern inc 2 used for the Rules tab) must navigate to the Hot tab and
   assert the view renders: `.hot-view` present, "Hot Topics" header, and the earnings / macro /
   news sections. This is the check that actually proves the extraction is wired correctly.
5. Spot-check one or two other harness shells actually mount after their script-list edit (they all
   share the same failure mode if the tag is missing).

## Net effect

- `app.js` ≈ **−143 lines** (view body ~136 + 2 view-local consts ~9 removed; +1 bind line,
  +1 `window.PBApp` line).
- New file `pb-view-hot.js` ≈ **~150 lines** (view + 2 consts + IIFE + bridge read + `PBViews`
  publish).
- Changed files: `app.js`, `pb-view-hot.js` (new), `sw.js`, `index.html`,
  `.github/workflows/static.yml`, and the 16 `backend/test/verify-*.mjs` harness shells.
- Node suite count unchanged.

## What the spike produces (the actual deliverable)

Beyond the working extraction, a short written read-out for the Vite decision:

- **Wiring tax:** exact count of files/lines touched purely to register one new component
  (index.html + sw + static.yml×2 + 16 harnesses = ~19 wiring edits for one component).
- **Bridge ergonomics:** whether `window.PBApp` reads cleanly and how many members a *typical*
  component would need (informs whether the grab-bag stays manageable across ~20 more splits).
- **Recommendation** on whether to (a) continue no-build with this pattern, (b) bucket views into
  fewer feature-scripts to amortize the tax, or (c) introduce Vite — fed back to Jan as the input
  to the deferred build-step call.

## Out of scope / deferred

- **Any second component.** This is a one-component spike by design.
- **Pushing pure helpers to `pb-core`** (`timeAgo`/`hotToDate`/`hotDayDiff`) — Approach B; can be
  done later, per-helper, with characterization tests, if the bridge grows unwieldy.
- **React Context runtime** (Approach C) — deferred.
- **`Icon` relocation** to a shared React-components module (`pb-ui.js`) — not needed while the
  bridge suffices; revisit if/when many components need many shared leaves.
- **Committing to a naming scheme** for view files (`pb-view-*` per-view vs a `pb-views.js` bucket)
  — the per-view file is the honest unit for *measuring* the tax; the bucketing decision rides on
  the spike's read-out.
- The `demo-data.js` deploy-allowlist gap (GAPS.md #1, tracked separately).

## Spike read-out (measured on execution, 2026-07-11)

Executed inline; all gates green (20 node suites, mount gate `verify-refresh-behavior` ALL PASSED,
scratchpad Hot-tab render check ALL PASSED — `.hot-view` mounts from `pb-view-hot.js`, 3 sections,
and the moved `·` subtitle renders with no U+FFFD replacement char).

**One-component cost, measured:**
- **New file:** `pb-view-hot.js` — 160 lines. **`app.js`:** 12313 → 12166 (**−147**; git diff
  `+8 / −163` vs `f2028f1`).
- **Wiring tax:** **21 registration edits across 19 files** to load one component — index.html (1),
  sw `SHELL_ASSETS` (1), sw cache bump (1), `static.yml` cp-list + Guard-1 loop (2), and **16
  harness shells** (1 `<script>` each). The `deploy-assets.test.mjs` suite cross-checks index.html ↔
  SHELL_ASSETS ↔ allowlist and stayed green, so the three deploy touchpoints are provably in sync.
- **The tax is dominated by the 16-harness edit (16 of 21) and is per-NEW-FILE, not per-component.**
  It scales linearly in *files*, and is ~flat in *components-per-file*.
- **Bridge:** `window.PBApp` exports **5** members (`Icon`, `timeAgo`, `hotToDate`, `hotDayDiff`,
  `prettyName`). The reverse-global read (`const {…} = window.PBApp`) is a single ergonomic line;
  lazy call-time resolution meant load order was a non-issue and it worked first try. The standing
  risk is `PBApp` accreting into a large grab-bag as more components are split (each adds the union
  of its shared helpers).
- **Verification friction:** no node test is possible for a pure-UI view; correctness rides entirely
  on the browser render check. Confirmed the predicted trap — the eager `viewMap`
  `createElement(HotTopicsView,…)` only *renders* on the active tab, so a broken bind is invisible to
  the mount gate; the Hot-tab render check is mandatory, not optional.

**Recommendation for the Vite decision (Jan's call):** *No-build remains viable for the rest of
Phase 4 — but bucket, don't per-file.* The one cost that actually hurts (16 harness edits) is paid
per new script file, so splitting the remaining ~20 view/modal components into **one** growing
`pb-views.js` (or a small handful of feature buckets) pays that tax once instead of ~20 times; the
`PBApp` bridge and the extraction mechanism both scale cleanly. The genuine downsides bucketing does
*not* fix — no JSX (`React.createElement` verbosity persists), a growing `PBApp` grab-bag, and
zero node-testability of views — are real but tolerable for a single-developer app and do **not**
justify a high-risk bundler migration mid-refactor. **Suggested path:** continue no-build with a
bucketed `pb-views.js`; revisit Vite only if JSX ergonomics or the harness/precache model become the
actual bottleneck (e.g., once most views are extracted and the per-render createElement bulk is the
main friction). Per-file naming (`pb-view-hot.js`) was deliberately the honest measuring unit for
this spike; the next increment should adopt bucketing per this read-out.

## Commit note

Per Jan's standing rule (2026-06-29): I build in the working tree; **Jan reviews/commits/PRs**. The
spec doc + plan + code are left uncommitted for Jan.
