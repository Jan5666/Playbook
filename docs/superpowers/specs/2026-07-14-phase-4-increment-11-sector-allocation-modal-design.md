# Phase 4 increment 11 — first modal extraction: `SectorAllocationModal` → new `pb-modals.js`

**Date:** 2026-07-14
**Branch:** `claude/refactor-plan-next-7cr7q5` (off latest `origin/main` `3c74696`, post-inc-10)
**Status:** design approved by Jan (2026-07-14: first modal = `SectorAllocationModal`; destination = a **new `pb-modals.js`** file)

## Goal

Extract the **first modal** out of `app.js` to establish the modal-in-bucket pattern, so the
remaining ~10 modals become cheap follow-on adds. Per the inc-9/10 read-outs, "the next real
cost step is a modal (`onClose`/portal + money/alert shape)"; this increment takes that step
with the **cheapest, lowest-risk** modal and, at Jan's direction, seeds a **dedicated
`pb-modals.js` bucket** (sibling to `pb-views.js`) rather than reusing the views bucket.

`SectorAllocationModal` was chosen because it edits sector-weight **percentages**, not
cost-basis / deposit / alert code — so it sits cleanly outside CLAUDE.md rule #3 (no
characterization test is a prerequisite), and it uses the **dominant** modal shape
(`.modal` / `.modal-panel` / `.modal-handle` + `useSwipeDownToClose` + `useBodyScrollLock`)
that ~10 sibling modals share, so the infrastructure this increment bridges is reused widely.

## Scope (decided with Jan, 2026-07-14)

- **Component:** `SectorAllocationModal` (`app.js:4394–4424`), invoked from the
  sector-breakdown popup (`editWeightsFor`, `app.js:4782`).
- **Destination:** a **new** browser-only classic-script bucket `pb-modals.js`, registering
  `window.PBModals.SectorAllocationModal`, reading `app.js` internals via the existing
  `window.PBApp` render-time bridge — the same mechanism `pb-views.js` uses.
- **Chosen over** SectorDetailModal (drags in the heavy `ZoomPanHeatmap` + async
  `fetchSectorTrend`; uses the outlier close-animation/Escape lifecycle) and ContributionModal
  (money-adjacent, rule-#3-adjacent). This finishes the cheapest tier first, exactly as the
  view extractions did.

## Dependency inventory (verified on `app.js` @ `3c74696`)

| Dependency | Source | Also used elsewhere? | Disposition |
|---|---|---|---|
| `useState`, `useRef` | React UMD global | — | destructured in the `pb-modals.js` IIFE |
| `useSwipeDownToClose` | app.js:300 (hook) | **yes — 10 modals** | **bridge** (new) — stays in app.js |
| `useBodyScrollLock` | app.js:230 (hook) | **yes — 12 modals** | **bridge** (new) — stays in app.js |
| `SectorWeightRows` | app.js:4352 (component) | **yes — position editor (app.js:10749)** | **bridge** (new) — stays in app.js |
| `Icon` | app.js React leaf | yes | **bridge** (already present from inc 8) |
| `parseFloat` / `isFinite` | native | — | no change |

The decisive finding: **`SectorWeightRows` cannot move with the modal.** Unlike inc-10's
`ruleSection` (view-local, moved with `RulesView`), `SectorWeightRows` has a **second caller**
still in `app.js` — the position editor at `app.js:10749` (`rows: sectorRows`). So it **stays
in `app.js` and is reached through the bridge**, exactly like inc-10's shared `THESIS_SNAPSHOT`.
The modal moves alone.

## Mechanism

`pb-modals.js` (new file, mirrors `pb-views.js`): a BOM + IIFE that destructures
`{ useState, useRef } = React`, holds `SectorAllocationModal` moved **verbatim** (Node
line-range slice — never the Edit tool; `app.js` carries a BOM and the modal subtitle contains
a literal `·` (U+00B7)), and registers `window.PBModals.SectorAllocationModal`. One render-time
lead read is injected as the first body statement:

```js
function SectorAllocationModal({ ticker, market, name, initialWeights, onClose, onSave }) {
  const { Icon, useSwipeDownToClose, useBodyScrollLock, SectorWeightRows } = window.PBApp;
  /* … body verbatim … */
}
```

`app.js` changes: the modal def becomes a pointer comment + `const SectorAllocationModal =
PBModals.SectorAllocationModal;` (module-scope bind at the old site — the inc-10 pattern;
`PBModals` global exists because `pb-modals.js` loads before `app.js`). The bridge publish line
grows **8 → 11** (`+useSwipeDownToClose, +useBodyScrollLock, +SectorWeightRows`; all defined
well before the publish → TDZ-safe). `SectorWeightRows` (app.js:4352) is **untouched**.

### Bridge economics

This is a bigger bridge jump than the +1 view adds — by design. The two lifecycle hooks are
**shared modal infrastructure** (12 / 10 callers); putting them on the bridge now means the
remaining ~10 modal extractions inherit them for free. This increment front-loads the
modal-infra cost so the tier behind it is cheap.

## Wiring (the payoff is deferred — this seeds a new file, so the full tax is paid once)

Because `pb-modals.js` is a **new runtime file**, every `pb-views.js` wiring site gets a
`pb-modals.js` twin (CLAUDE.md "new runtime file" checklist):

1. `index.html` — `<script src="./pb-modals.js">` after `pb-views.js`, before `data.js`.
2. `sw.js` — `SHELL_ASSETS` entry + `CACHE_NAME` **v58 → v59**.
3. `.github/workflows/static.yml` — the `cp` allowlist **and** the Guard-1 loop.
4. All **16** app-mounting `backend/test/verify-*.mjs` harness shells.
5. `architecture-map.html` — docs sync (load-chain note + the 11-member bridge).

`deploy-assets.test.mjs` cross-checks sw.js ↔ index.html ↔ static.yml, so it is the guard
that fails loudly if any of #1–#3 is inconsistent.

## Verification gate

1. `node --check` clean on `app.js` and `pb-modals.js`.
2. Full node suite green (money gate unaffected — no money/import code moves);
   `deploy-assets.test.mjs` green (proves the new file is wired consistently everywhere).
3. Anti-drift greps: `function SectorAllocationModal` = 0 in `app.js` / 1 in `pb-modals.js`;
   `const SectorAllocationModal = PBModals.SectorAllocationModal;` present; `function
   SectorWeightRows` still = 1 in `app.js` (stayed); bridge line carries the 3 new members;
   `window.PBModals.SectorAllocationModal` registration present.
4. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED.**
5. **Render check — `verify-sector-weights.mjs`.** This harness already drives the modal:
   it seeds a multi-sector VOO breakdown, opens the sector-breakdown popup, taps VOO's
   edit-allocation button, and asserts the dedicated "Sector allocation" modal opens scoped
   to VOO with its 3 seeded weight rows + running total (`.sector-split-row` /
   `.sector-split-sum` — `SectorWeightRows`' DOM, reached through the bridge). The subtitle
   `VOO · …` also proves the `·` moved byte-exact (no U+FFFD).

## Out of scope / deferred

- Every other modal (SectorDetail/Detail/Alerts/Contribution/Import/Position/Sell/Buy/Settings)
  — Sell/Buy are the money/alert-shape step that rule #3 gates on a characterization test.
- Portals (`SectorAllocationModal` renders inline; no `createPortal`).
- The big stateful views; pushing helpers to `pb-core`; React Context; Vite (settled — the
  no-build classic-script bucket pattern continues).

## Commit note

Development on `claude/refactor-plan-next-7cr7q5` with a commit + push to that feature branch.
No PR is opened and `main` is never pushed — Jan reviews and lands. Scratchpad slice/patch/
vendor scripts are gitignored, not committed.

## Measured read-out (2026-07-14, on execution)

All gates green — 22 node suites (money gate + `deploy-assets` wiring guard included), mount
gate `verify-refresh-behavior` **ALL PASSED**, render check `verify-sector-weights`
**all PASSED** (first try, no flaky CDP race this run).

**Bucketing economics, measured:**
- **The full new-file tax was paid once, and the guard proved it:** `app.js` **−31 lines**
  (34-line modal block → 3-line pointer+bind), new `pb-modals.js` **43 lines**, `sw.js`
  **v58 → v59**. Wiring touched `index.html` + `sw.js` + `static.yml` (cp + Guard-1) + **16**
  harness shells + `architecture-map.html`. `deploy-assets.test.mjs` stayed green **only after**
  all three deploy sites agreed — the one guard that makes the new-file tax self-checking.
- **Bridge:** `window.PBApp` grew **8 → 11** (`+useSwipeDownToClose, +useBodyScrollLock,
  +SectorWeightRows`). The two lifecycle hooks are shared infra now bridged for the ~10 modals
  behind this one; `SectorWeightRows` correctly **stayed in `app.js`** (2nd caller: the
  position editor) and is reached through the bridge — the same "genuinely shared → stays,
  bridged" call inc-10 made for `THESIS_SNAPSHOT`. The modal moved alone.
- **Verification friction:** the render check was **free** — `verify-sector-weights.mjs`
  already drove the modal end-to-end, so no new harness logic was needed; it proved the
  `PBModals` bind, the bridged `SectorWeightRows`, and the byte-exact `·` in one run.
- **Environment note:** the committed harnesses assume Windows Chrome + unpkg; in the remote
  Linux container the mount + render harnesses were run from throwaway **scratchpad copies**
  patched to pin `ROOT`, serve a locally-`npm i`'d React (unpkg is egress-blocked, 403), and
  add `--no-sandbox` (`CHROME_PATH` is already honored by the harness). The committed harnesses
  were **not** modified beyond the one-line `pb-modals.js` script tag.

**Conclusion:** the first modal is extracted and a dedicated `pb-modals.js` bucket is seeded.
The new-file wiring tax was paid once (and is guarded by `deploy-assets`); the modal-lifecycle
hooks are now on the bridge, so the next modals — up to the Sell/Buy money-shape step that
rule #3 gates — are cheap bucket adds in the mould of the inc 8–10 view tier.
