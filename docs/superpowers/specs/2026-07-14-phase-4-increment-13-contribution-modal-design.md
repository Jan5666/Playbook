# Phase 4 increment 13 — third modal: `ContributionModal` -> existing `pb-modals.js`

**Date:** 2026-07-14
**Branch:** `claude/refactor-plan-next-7cr7q5` (stacks on inc-12, unmerged)
**Status:** design approved by Jan (2026-07-14: the deposit/withdraw modal pair — cheap bucket adds)

## Goal

Keep cashing in the `pb-modals.js` bucket: extract a third modal as a cheap add —
`app.js` + a `pb-modals.js` splice + a one-line `sw.js` cache bump — exactly as inc 11/12
were. `ContributionModal` is the "log a single deposit / withdrawal" sheet opened from the
growth card; inc-14 will follow with its sibling `ContributionImportModal`.

It is **display + input only**: a deposit/withdraw toggle, currency select, amount, an
optional locked USD-landed rate, date, note. It does **no money math itself** — it hands the
raw values to the parent via `onSave`, so the deposit-profit / landed-rate semantics that
CLAUDE.md rule #3 guards stay entirely in the App layer. Cleanly outside rule #3.

## Dependency inventory (verified on `app.js` @ post-inc-12)

| Dependency | Source | Disposition |
|---|---|---|
| `useState`, `useRef` | React UMD | already in the bucket IIFE destructure |
| `useSwipeDownToClose`, `useBodyScrollLock` | app.js | **bridge** — already present |
| `Icon` | app.js leaf | **bridge** — already present |
| `sanitizeDecimalInput` | app.js:1377 (`function`) | **bridge** (new) — app.js internal, stays (shared decimal-input helper used across many inputs) |
| `parseDecimal` | pb-core.js:617 (`PBCore.parseDecimal`) | **IIFE global read** (new) — a true module global, read directly like `PBContent`/`PBStore`, NOT bridged |

No `PB_DATA`/`PBStore`/`PBImport`, no money/alert code.

## Mechanism

`pb-modals.js` gains `ContributionModal`, moved **verbatim** via a Node line-range slice —
never the Edit tool (BOM + literal non-ASCII bytes; the modal carries a literal `—`). The
slice is bounded on the **next top-level `function`**, then rewound past the leading comment
block that describes the *following* modal (`ContributionImportModal`) so that comment stays
in `app.js` for inc-14; the assertion "last moved line is `}`" pins the boundary.

Two seam edits in the bucket:
- IIFE gains `const parseDecimal = PBCore.parseDecimal;` (PBCore is a global loaded before
  `pb-modals.js`, read directly — same treatment `parseDecimal` had inline in app.js).
- One render-time lead read injected as the modal's first body statement:
  `const { Icon, useSwipeDownToClose, useBodyScrollLock, sanitizeDecimalInput } = window.PBApp;`

> **Slice-script footgun (hit + fixed):** the modal body contains `'R' : '$';`. Passing the
> block as the *replacement* string to `String.prototype.replace` makes `$'` expand to
> "everything after the match", truncating the file. inc-12's script never tripped this
> because `SectorDetailModal` had no `$`-sequence. Fix: pass a **replacement function**
> (`.replace(anchor, () => text + anchor)`), which never interprets `$` patterns.

`app.js`: the modal def becomes a 2-line pointer comment + `const ContributionModal =
PBModals.ContributionModal;`; the bridge grows **13 -> 14** (`+sanitizeDecimalInput`, a
`function` defined long before the publish -> TDZ-safe). The invocation at `app.js:5127`
(`contribModalOpen ? React.createElement(ContributionModal, {...})`) is unchanged.

## Wiring (minimal — the bucket payoff)

- `sw.js` `CACHE_NAME` **v60 -> v61**. That is the only shipped-file wiring.
- **Zero** edits to `index.html` / `static.yml` / `SHELL_ASSETS` / the 16 harnesses —
  `pb-modals.js` is already wired; `deploy-assets.test.mjs` stays green (asset set unchanged).
- `architecture-map.html` — docs sync: bridge note 13 -> 14 (`+sanitizeDecimalInput`).

## Verification gate

1. `node --check` clean on `app.js` and `pb-modals.js`.
2. Full node suite green (money gate unaffected — the modal delegates money math);
   `deploy-assets` green.
3. Anti-drift greps: `function ContributionModal` = 0 in app.js / 1 in pb-modals.js; the bind
   present; registration present; bridge carries `sanitizeDecimalInput`; IIFE has
   `const parseDecimal = PBCore.parseDecimal;`.
4. **Mount gate — `verify-refresh-behavior.mjs` ALL PASSED.**
5. **Render check — `verify-modals.mjs`** (a committed harness that seeds
   `pb.contributions.v2`, opens the deposit modal, and logs a deposit). Screenshot-style with a
   known-flaky "Execution context destroyed" CDP race — rerun on that race. The
   contribution-modal panels must render (non-zero) with no page exception.

## Out of scope / deferred

`ContributionImportModal` (inc-14); other modals; money/alert code; portals; Vite.

## Commit note

Development on `claude/refactor-plan-next-7cr7q5` (inc-13 stacks on inc-12). Commit + push to
the feature branch; no PR; `main` never pushed — Jan reviews and lands. Scratchpad
slice/harness scripts are gitignored, not committed.

## Measured read-out (2026-07-14, on execution)

All gates green — 22 node suites (money gate + `deploy-assets` included), mount gate
`verify-refresh-behavior` **ALL PASSED**, and the `verify-modals` render check **exit 0, no
page exception**: the deposit and import panels both render at 440x852, the import title reads
"Import deposits & withdrawals"; literal `—` byte-exact (no U+FFFD). (The harness's
"app mounted: false" probe is a pre-existing CDP mount-probe timing quirk — the app
demonstrably mounted: every tab enumerated and every modal opened.)

**Bucketing economics, measured:**
- **The cheap add held:** `app.js` **-105 lines** net (108-line modal -> 3-line pointer+bind),
  `pb-modals.js` **183 -> 297**, `sw.js` **v60 -> v61** (one line). **Zero**
  index/static/harness edits — the bucket file was already wired (`deploy-assets` stayed
  green). The bucket now holds **3** modals.
- **Bridge:** `window.PBApp` grew **13 -> 14** (`+sanitizeDecimalInput`, an app.js internal
  reached via the bridge). `parseDecimal` was added as an IIFE `PBCore.parseDecimal` read
  (a true global, not a bridge member).
