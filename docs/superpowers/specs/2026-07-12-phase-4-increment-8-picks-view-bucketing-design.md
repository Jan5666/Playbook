# Phase 4 increment 8 — bucketing: `pb-view-hot.js` → `pb-views.js` + extract PicksView

**Date:** 2026-07-12
**Branch:** `refactor/phase-4-increment-8-picks-view-bucketing` (off latest `origin/main`)
**Status:** design approved by Jan (2026-07-12); awaiting spec review → writing-plans

## Goal

Adopt the **bucketed-views** pattern the increment-7 spike read-out recommended. Increment 7
extracted exactly one component into its own per-view file (`pb-view-hot.js`) *to measure* the
cost of a split; its read-out concluded the one cost that actually hurts — the 16 test-harness
edits — is paid **per new script file**, not per component, and therefore recommended: *continue
no-build, but bucket views into one growing `pb-views.js` so that tax is paid once.*

This increment executes that recommendation in two behavior-green parts:

1. **Rename** the spike file `pb-view-hot.js` → the generic bucket `pb-views.js` (re-pointing every
   wiring reference). Behavior-neutral: HotTopicsView still serves the Hot tab.
2. **Extract a second component — `PicksView`** — into that bucket, proving the thesis: adding a
   component to an *existing* bucket costs **zero** new harness/deploy wiring (only `app.js` edits),
   and the `window.PBApp` bridge scales cleanly past its first consumer.

Success = one bucket file (`pb-views.js`) holding two real view components, all verification gates
green, and a short measured note confirming the cheap-add property.

## Scope (decided with Jan, 2026-07-12)

- **Bucket file:** rename `pb-view-hot.js` → `pb-views.js` (`git mv`), then add one component into it.
  (Chosen over keeping the misleading `pb-view-hot.js` name, and over creating a fresh file + deleting
  the old — a `git mv` is the cheapest honest correction of the spike's deliberately-temporary
  per-view name, done now while the bucket's wiring is still minimal.)
- **Component:** `PicksView` — the "New Picks" tab ([app.js:7913-7973](../../../app.js#L7913),
  ~61 lines). No money mutation; a genuine tab view (not a trivial static one); clean dependency set.
  (Chosen over `HedgesView` — near-identical, deliberately deferred as the *next* increment's
  near-free cheap-add — and over `RulesView`, which is too trivial to exercise the bridge.)
- **Shared-dependency mechanism:** the existing `window.PBApp` app-runtime bridge from increment 7.
  Grow it from 5 → 7 members (`+PriceBlock`, `+fmt`). No new mechanism introduced.

## Dependency inventory (verified on current `app.js`)

`PicksView`'s complete external set — an exhaustive scan of its body ([app.js:7913-7973](../../../app.js#L7913)):

| Dependency | Source | Also used elsewhere? | Disposition |
|---|---|---|---|
| `onOpenDetail` | prop | — | unchanged interface (call site [app.js:3395](../../../app.js#L3395)) |
| `PBStore.usePricesMap()` | existing global | — | qualified, no change |
| `DATA.NEW_PICKS` | `window.PB_DATA` (data.js global; `app.js:11` binds `const DATA = window.PB_DATA`) | yes, everywhere | **read `window.PB_DATA` directly** in `pb-views.js` |
| `PriceBlock` | `app.js:3782` React leaf (`React.memo`) | yes — many views | **bridge** (add to `PBApp`) |
| `fmt` | `app.js:1262` display helper | yes — everywhere | **bridge** (add to `PBApp`) |
| `React.createElement` | UMD global | — | qualified, no change (no hooks used) |

Built-in `Date`/`String`/`Number` methods and the plain data fields of each pick (`p.ticker`,
`p.entryPrice`, `p.targetPrice`, `p.conviction`, `p.allocation`, `p.name`, `p.sector`, `p.thesis`,
`p.upside`) aside, this is the **complete** set. `PicksView` uses **no** React hooks directly
(only `PBStore.usePricesMap()`), so — unlike HotTopicsView — it needs no `useEffect`/`useRef`.

### The bridge-vs-global distinction (a deliberate design point)

`window.PBApp` is **only** for `app.js` *internals* that an extracted script cannot otherwise reach —
React leaf components (`Icon`, `PriceBlock`) and helper functions defined in `app.js` (`timeAgo`,
`fmt`, …). Genuine cross-script globals — `PBStore` (from `pb-store.js`) and `PB_DATA` (from
`data.js`) — are read **directly**, never routed through the bridge. This keeps `PBApp` from
accreting into the grab-bag the inc-7 read-out flagged as the standing risk: it grows only by
app.js-internal primitives, and only the ones a bucketed view actually consumes.

Concretely, `PicksView` reaches `DATA` by injecting `const DATA = window.PB_DATA;` as a lead line in
its body (mirroring `app.js:11`), read at render time — by which point `data.js` (loaded after
`pb-views.js`, before render) has set `window.PB_DATA`. The remainder of the body is moved verbatim
(`DATA.NEW_PICKS` unchanged).

## The mechanism — `pb-views.js` after this increment

`pb-views.js` is one browser-only classic-script IIFE registering each extracted view on
`window.PBViews`:

```js
// pb-views.js - extracted view components bucket (Phase 4). Browser-only classic script.
// Registers window.PBViews.<View> and reads shared app.js primitives from window.PBApp at render.
(function () {
  const { useEffect, useRef } = React; // UMD global; HotTopicsView uses these hooks unqualified

  // ─── Hot Topics ───  (moved in increment 7, unchanged)
  const HOT_TAG_LABEL = { /* … */ };
  function hotCountdown(diff) { /* … */ }
  function HotTopicsView(_refHT) {
    const { Icon, timeAgo, hotToDate, hotDayDiff, prettyName } = window.PBApp;
    /* … */
  }

  // ─── New Picks ───  (moved in increment 8)
  function PicksView(_ref9) {
    const { PriceBlock, fmt } = window.PBApp; // app.js internals via bridge
    const DATA = window.PB_DATA;              // data.js global, read directly
    let { onOpenDetail } = _ref9;
    const prices = PBStore.usePricesMap();
    /* … body moved verbatim from app.js:7913-7973 … */
  }

  window.PBViews = window.PBViews || {};
  window.PBViews.HotTopicsView = HotTopicsView;
  window.PBViews.PicksView = PicksView;
})();
```

**`app.js` changes:**

1. Grow the bridge at its publish site ([app.js:12243](../../../app.js#L12243)):
   ```js
   window.PBApp = { Icon, timeAgo, hotToDate, hotDayDiff, prettyName, PriceBlock, fmt };
   ```
   All seven members are defined before this point (`fmt` 1262, `Icon` 1321, `PriceBlock` 3782,
   the three hot helpers, `prettyName` 6075), so no TDZ.
2. Replace `function PicksView(_ref9) { … }` at 7913-7973 with a bind:
   ```js
   const PicksView = PBViews.PicksView;
   ```
   The `picks:` `viewMap` entry ([app.js:3395](../../../app.js#L3395)) is built inside `App()`'s
   render body, which runs after every module-scope `const` is initialized — so replacing the
   hoisted function declaration with a `const` bind is TDZ-safe, exactly as HotTopicsView's bind
   already is.
3. Update the inc-7 comment above the HotTopicsView bind (it names `pb-view-hot.js`) to
   `pb-views.js`.

### Extraction discipline (unicode / verbatim)

Move `PicksView`'s body **verbatim** via a Node line-range splice — never the Edit tool, never
retype (`app.js` has a BOM + CRLF and authors non-ASCII as `\uXXXX`/`\xXX` escapes; the middot in
`p.name, " \xB7 ", p.sector` is already an ASCII escape in source, but the move stays byte-safe
regardless). The **only** edited lines inside the moved body are the two injected lead lines
(`const { PriceBlock, fmt } = window.PBApp;` and `const DATA = window.PB_DATA;`). `pb-views.js`
keeps the file's existing BOM + CRLF (it is produced by renaming the inc-7 file, which already has
them, then splicing `PicksView` in via a Node script).

## Wiring — this is the cost the increment measures

**Part A — rename (`pb-view-hot.js` → `pb-views.js`), the one-time tax (~21 edits across 19 files):**

1. `git mv pb-view-hot.js pb-views.js`; update the file's own header comment.
2. `index.html` — the one `<script src="./pb-view-hot.js">` ([index.html:79](../../../index.html#L79)) → `./pb-views.js`.
3. `sw.js` — `SHELL_ASSETS` entry `./pb-view-hot.js` → `./pb-views.js`; **bump `CACHE_NAME` `playbook-shell-v53` → `v54`** (current value is v53, not the v52 the inc-7 plan left — later fixes bumped it).
4. `.github/workflows/static.yml` — both occurrences (the `cp` allowlist **and** the Guard-1 loop) `pb-view-hot.js` → `pb-views.js`.
5. All **16** app-mounting `backend/test/verify-*.mjs` harness shells — each embeds `<script src="/pb-view-hot.js">` → `/pb-views.js`.

No `.test.mjs` hardcodes the filename (`deploy-assets.test.mjs` derives the asset set dynamically),
so the rename breaks no test assertion; it only needs the three deploy touchpoints (index.html ↔
`SHELL_ASSETS` ↔ allowlist) to stay in lockstep — which that suite then re-verifies.

**Part B — extract PicksView, the cheap add (the payoff):** `app.js` only — remove the function,
add the bind, extend `PBApp`. Splice `PicksView` into `pb-views.js`. **Zero** new harness / sw-asset
/ static.yml / index.html edits (the bucket file is already wired). The single sw cache bump from
Part A covers both parts.

No worker/wrangler impact (the worker bundles `pb-core`, never view code).
`pb-core`/`pb-data`/`pb-store`/`pb-content`/`pb-import`/`data.js` untouched.

## Verification gate

1. `node --check` clean on `app.js` **and** `pb-views.js`.
2. All existing node suites green (`node backend/test/*.test.mjs`) — money gate unaffected (no money
   code touched); `deploy-assets.test.mjs` green confirms the rename kept index.html ↔ `SHELL_ASSETS`
   ↔ allowlist in sync.
3. **Mount gate — `verify-refresh-behavior.mjs` `ALL PASSED`** after its shell's script rename: app
   mounts, no `PBViews`/`PBApp` ReferenceError; the standing "holdings rows have NO SessionBadge"
   guard still holds.
4. **Render check (scratchpad, not committed) — the critical one.** `viewMap` builds
   `React.createElement(PicksView, …)` eagerly every render but only *renders* the `picks` entry on
   the active tab, so a broken `PBViews.PicksView` bind yields an `undefined` element **type** the
   mount gate never exercises. A headless check must assert:
   - app mounts;
   - `window.PBViews.HotTopicsView` **and** `window.PBViews.PicksView` are both functions, and
     `window.PBApp.PriceBlock`/`window.PBApp.fmt` are defined;
   - **Hot tab still renders** (`.hot-view` present) — the rename regression guard;
   - **Picks tab renders** — navigate to the `picks` tab and assert the `.pos-card` grid renders
     with at least one card (proves the new extraction is wired). This is the check that actually
     proves correctness.

## Net effect

- `app.js` ≈ **−61 lines** (PicksView body removed; +1 bind line, +2 bridge members on one existing
  line, +0 net on the updated comment).
- `pb-views.js` gains ~**+63 lines** (PicksView + its two injected lead lines + one `PBViews`
  registration line), and is renamed from `pb-view-hot.js`.
- Bridge `window.PBApp`: **5 → 7** members.
- One bucket file now holds **2** view components.
- Changed files: `app.js`, `pb-views.js` (renamed from `pb-view-hot.js`), `sw.js`, `index.html`,
  `.github/workflows/static.yml`, and the 16 `backend/test/verify-*.mjs` harness shells.
- Node suite count unchanged.

## What this increment produces (the deliverable)

Beyond the working extraction, a short measured note (appended to this spec on execution) confirming
the bucketing economics: the **rename** cost ~21 wiring edits (one-time), while the **PicksView add**
cost 0 harness/deploy edits and grew `PBApp` by 2 — i.e., the per-component cost inside an existing
bucket is `app.js`-only, validating the read-out's recommendation and setting the pattern for the
remaining ~18 components (`HedgesView` next as the near-free follow-up).

## Out of scope / deferred

- **`HedgesView`** — near-identical to `PicksView` (same `PriceBlock`+`fmt`+`DATA` shape);
  deliberately left as the *next* increment's near-free cheap-add, to demonstrate a second bucket
  addition with an already-saturated bridge (0 new `PBApp` members).
- **Any modal** (SellModal/BuyModal/etc.) — modals touch money/alert code and a different
  (`onClose`/portal) shape; out of this increment.
- **Pushing pure helpers to `pb-core`** (Approach B) — not needed while the bridge suffices.
- **React Context** (Approach C) and **Vite / a build step** — deferred, unchanged from inc 7.
- The `demo-data.js` deploy-allowlist gap (GAPS.md #1, tracked separately).

## Commit note

Per Jan's standing rule (2026-06-29): I build on the branch in the working tree; **Jan reviews,
commits, PRs, and merges.** Spec + plan + code are left for Jan; nothing is pushed. Scratchpad slice
scripts and the render-check harness are throwaway — not committed.
