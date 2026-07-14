# Phase 4 increment 10 — bucket the last two simple views: RulesView + OverviewView → `pb-views.js`

**Date:** 2026-07-14
**Branch:** `claude/refactor-plan-next-tbupah` (off latest `origin/main` `763aced`)
**Status:** design approved by Jan (2026-07-14: "Rules + Overview")

## Goal

Extract the two remaining **simple, prop-light** view components — `RulesView` and
`OverviewView` — into the existing `pb-views.js` bucket, clearing every low-coupling view
out of `app.js`. After this increment the bucket holds **5** views and the only views left
in `app.js` are the large, stateful ones (Dashboard/Current/Watchlist/Heatmap/TFSA) plus
all modals — a clean boundary before the next, genuinely harder cost step (modals:
`onClose`/portal + money/alert shape, per the inc-9 read-out).

This is a **near-free bucket add** in the mould of inc 8/9: the 16-harness wiring tax was
already paid when `pb-views.js` was created (inc 8), so the per-component cost is
`app.js` + bucket splice + a one-line `sw.js` cache bump.

## Scope (decided with Jan, 2026-07-14)

- **Components:** `RulesView` and `OverviewView` — the last two views invoked with
  `null`/minimal props (`viewMap` entries `rules:`/`overview:`, both
  `React.createElement(View, null)`). Chosen over starting on modals (deferred as the
  "next real cost step") and over the big stateful views (higher risk, larger bridge
  growth) — these two finish the cheap tier first.
- **Mechanism:** the existing `window.PBApp` app-runtime bridge + `window.PBViews` bucket.
  Grow the bridge by exactly **one** member (`+THESIS_SNAPSHOT`); RulesView needs **zero**
  new members.

## Dependency inventory (verified on `app.js` @ `763aced`)

### RulesView (app.js:8498–8523) — zero bridge growth

| Dependency | Source | Also used elsewhere? | Disposition |
|---|---|---|---|
| `ruleSection` | app.js:8485 (pure helper) | **No** — only RulesView (8500/8522) | **move** into `pb-views.js` with the view |
| `RULES` | `PBContent.RULES` (app.js:458 binds it) | yes | read `PBContent.RULES` directly in the view body |
| `DATA.RISKS` | `window.PB_DATA` (data.js) | yes, everywhere | read `window.PB_DATA` directly |
| `React.createElement` | UMD global | — | qualified, no change (no hooks) |

RulesView uses **no** React hooks and **no** `app.js` internals → it needs nothing from
`window.PBApp`. `ruleSection` is view-local (a pure `(section, cardClass)` → array helper)
and moves with the view.

### OverviewView (app.js:8524–8578) — +1 bridge member

| Dependency | Source | Also used elsewhere? | Disposition |
|---|---|---|---|
| `PriceBlock` | app.js React leaf | yes — many views | **bridge** (already present from inc 8) |
| `THESIS_SNAPSHOT` | app.js:2810 const | **yes — fetch plan app.js:2814** (comment 2807) | **bridge** (new; stays in app.js) |
| `DATA.PILLARS`/`DATA.HOLDINGS` | `window.PB_DATA` | yes | read `window.PB_DATA` directly |
| `PBStore.usePricesMap()` | pb-store global | — | qualified, no change |

`THESIS_SNAPSHOT` cannot simply move with the view — it is read by the fetch plan
(`overview: THESIS_SNAPSHOT.map(t => 'US:' + t)`, app.js:2814) — so it stays in `app.js`
and is reached through the bridge, exactly the bridge-vs-global rule from the inc-8 spec
(`PBApp` carries only `app.js` internals a bucketed view can't otherwise reach; genuine
cross-script globals `PB_DATA`/`PBStore`/`PBContent` are read directly).

## Mechanism

`pb-views.js` gains `ruleSection` + `RulesView` + `OverviewView` (moved **verbatim** via a
Node line-range splice — never the Edit tool: the files carry a BOM and author non-ASCII as
`\uXXXX` escapes; OverviewView contains `→`/`—`). Injected render-time lead reads:

```js
function RulesView() {
  const RULES = PBContent.RULES;
  const DATA = window.PB_DATA;
  /* … body verbatim … */
}
function OverviewView(_ref1) {
  const { PriceBlock, THESIS_SNAPSHOT } = window.PBApp;
  const DATA = window.PB_DATA;
  const prices = PBStore.usePricesMap();
  /* … body verbatim … */
}
```

`app.js` changes: the contiguous span `ruleSection`..`OverviewView` (8485–8578) becomes a
comment + two binds (`const RulesView = PBViews.RulesView;` /
`const OverviewView = PBViews.OverviewView;`); the bridge publish line grows to 8
(`+THESIS_SNAPSHOT`, defined at 2810 — well before the publish at ~12187, TDZ-safe). The
`viewMap` entries are unchanged (same names, now `const` binds; built in `App()`'s render
body → TDZ-safe).

### Encoding note (this checkout)

Contrary to the older CLAUDE.md/inc-9 note, `app.js` and `pb-views.js` are stored **LF**
in this checkout (`git ls-files --eol` → `i/lf w/lf`; no `.gitattributes`, no autocrlf),
with a leading BOM. The slice script reads/writes `'utf8'` (preserves BOM) and
splits/joins on `'\n'`. The `→`/`—` escapes are ASCII in source and move
byte-for-byte.

## Wiring (the payoff — minimal)

- `app.js` (remove 3 defs → 2 binds + grow bridge by 1) + `pb-views.js` (splice + 2
  registrations) + `sw.js` (cache bump **v57 → v58**).
- **Zero** edits to `index.html`, `.github/workflows/static.yml`, the 16 `verify-*.mjs`
  harnesses, or any `pb-core`/`pb-data`/`pb-store`/`pb-content`/`pb-import`/`data.js`. No
  worker/wrangler impact.

## Verification gate

1. `node --check` clean on `app.js` and `pb-views.js`.
2. All node suites green (money gate unaffected — no money code moves); `deploy-assets` stays
   green (asset set unchanged).
3. Anti-drift greps: `function ruleSection`/`RulesView`/`OverviewView` = 0 in app.js, 1 each
   in pb-views.js; the two `const … = PBViews.…` binds present; bridge line contains
   `THESIS_SNAPSHOT`; both `window.PBViews.{Rules,Overview}View` registrations present.
4. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED** (app mounts; no
   `PBViews`/`PBApp` ReferenceError; the no-SessionBadge holdings guard holds).
5. **Rules + Overview render check (the decisive one).** `viewMap` builds each view eagerly
   but only renders it on the active tab, so a broken bind is invisible to the mount gate.
   Navigate to Rules (assert rule `.bullet-list` sections + "Key risks") and Overview
   (assert the PILLARS `.grid-3 .card` grid + `.pos-card` live snapshot; assert the moved
   `→`/`—` render with **no U+FFFD**); assert `Object.keys(window.PBApp).length === 8`;
   re-check the Picks sibling still renders.

## Out of scope / deferred

- Any modal (SellModal/BuyModal/…) — different `onClose`/portal + money/alert shape; the
  next real cost step.
- The big stateful views (Dashboard/Current/Watchlist/Heatmap/TFSA).
- Pushing pure helpers to `pb-core` (Approach B), React Context (C), Vite (deferred, unchanged).

## Commit note

This session's task directs development on `claude/refactor-plan-next-tbupah` with a
commit + push to that feature branch. No PR is opened and `main` is never pushed (a push to
main is a production deploy) — Jan reviews and lands. Scratchpad slice/harness scripts are
throwaway (gitignored) — not committed.

## Measured read-out (2026-07-14, on execution)

Executed inline; all gates green — 22 node suites (money gate + `deploy-assets` included),
mount gate `verify-refresh-behavior` **ALL PASSED**, and the Rules + Overview render check
**ALL PASSED**.

**Bucketing economics, measured:**
- **The cheap add held:** `app.js` −90 lines (12189 → 12099; `git diff` +? shows the 3 defs
  removed for 2 binds), `pb-views.js` +104 (280 → 384); `sw.js` cache **v57 → v58** (one
  line). **Zero** new harness / `static.yml` / `index.html` edits — the bucket file was
  already wired (`deploy-assets.test.mjs` stayed green, asset set unchanged). The bucket now
  holds **5** components (HotTopics + Picks + Hedges + Rules + Overview).
- **Bridge:** `window.PBApp` grew **7 → 8** (`+THESIS_SNAPSHOT` only). RulesView added
  **zero** members (it reaches `PBContent.RULES`/`PB_DATA` directly and carries its own
  view-local `ruleSection` helper — the first extraction to move a helper *with* its view);
  OverviewView reused the already-bridged `PriceBlock` and needed only `THESIS_SNAPSHOT`,
  which is genuinely shared with the fetch plan (app.js:2814) and so correctly stayed in
  `app.js` behind the bridge. At 8 members the grab-bag is still very manageable.
- **Verification friction:** unchanged — no node test possible for pure-UI views; correctness
  rode on the browser render check. The predicted eager-`viewMap`/active-tab trap held: a
  broken bind is invisible to the mount gate, so the Rules-tab (3 `.bullet-list` sections +
  "Key risks") and Overview-tab (3 PILLARS `.card` + 4 `.pos-card` snapshot; `→`/`—`
  intact, no U+FFFD) checks are what actually proved it. Passed first try after the
  extraction.
- **Environment note:** the committed harnesses assume Windows Chrome + unpkg; in the remote
  Linux container both had to be worked around (local npm React, `--no-sandbox`,
  `CHROME_PATH`) via throwaway scratchpad patches. The harnesses themselves were **not**
  modified. (A future hardening task could make the harnesses honor `CHROME_PATH` for the
  sandbox flag and fall back to a local React copy — but that is out of this increment.)

**Conclusion:** the last two simple views are now bucketed for the price of `app.js` + a
splice + a one-line cache bump and a single new bridge member. All low-coupling views are
extracted; the remaining `app.js` views are the large stateful ones and the modals. Per the
inc-9 read-out, the **next real cost step is a modal** (`onClose`/portal + money/alert
shape), which will exercise the bridge and verification model differently from a pure tab view.
