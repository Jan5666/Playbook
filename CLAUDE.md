# CLAUDE.md — Playbook

Personal investment-tracking PWA (React 18 UMD, **no build step, no JSX**), deployed
to GitHub Pages, with an optional Cloudflare Worker for push + encrypted backup.

- **[PROJECT.md](PROJECT.md)** — architecture, data flow, design decisions, critical paths. Read before any structural change.
- **[GAPS.md](GAPS.md)** — every known weakness, ranked by severity, each with a scoped fix.
- **[SECURITY_ROADMAP.md](SECURITY_ROADMAP.md)** — the post-refactor security/platform plan. **The refactor is finished (2026-07-26), so this is now the active plan.**
- **docs/superpowers/{specs,plans}/** — the spec + plan for every refactor increment; the written history of why each seam exists.

## Commands

There is **no build, no lint, no npm scripts** at the root.

```bash
# Run the app: serve the repo root over HTTP (any static server), open index.html
npx serve .                       # or: python -m http.server

# Unit tests — zero-framework Node scripts, run individually (cwd doesn't matter):
node backend/test/money-math.test.mjs
for f in backend/test/*.test.mjs; do node "$f" || break; done   # full suite (33)

# MONEY GATE — must be green on ANY change touching money/import code:
#   money-math, cost-basis, import-matching, ee-ocr-parse, fx-providers

# Browser smoke (spawns local Chrome + HTTP server, mocks Yahoo). THE mount gate:
node backend/test/verify-refresh-behavior.mjs
# Reliable smokes: verify-refresh-behavior, verify-watchlist, verify-settings.
# The CDP "Execution context destroyed" race is FIXED (GAPS.md #12, 2026-07-26): it
# was structural, not luck — Chrome destroys the about:blank context when the harness
# URL commits and harnesses attach in exactly that window — and the retry that
# verify-refresh-behavior always had is now in all 16 others. If you still see it,
# suspect a NEW cause, don't write it off as the old flake.
# verify-indicators' 2 ribbon FAILs and verify-settings' "Alerts: menu overflows" are
# also fixed, so they are no longer expected-red. Chrome path is hardcoded:
# C:\Program Files\Google\Chrome\Application\chrome.exe

# Syntax check (necessary, NOT sufficient — see Gotchas):
node --check app.js

# webpush crypto tests need a dep once:  cd backend/test && npm install

# Deploy: push to main = live site (Pages workflow stages an ALLOWLIST, static.yml).
# The Worker NEVER auto-deploys — Jan runs:  cd backend && npx wrangler deploy
```

## The rules (non-negotiable)

1. **Jan commits, merges, and pushes — you don't.** Build + verify in the working
   tree or on a branch off latest `origin/main`; leave landing to him. Never revert
   tweaks he made between increments.
2. **A push to main is a production deploy.** Never push unprompted. Never commit
   anything credential-shaped (scan `git diff --cached`); anything committed can end
   up public.
3. **Never refactor money or alert code without a characterization test pinning
   current behavior first.** Cost basis excludes broker fees; deposit profit uses
   the locked landed-USD rate — these semantics are user-confirmed, don't "fix" them.
4. **Do NOT re-add `SessionBadge` to `HoldingRow`** — Jan removed it deliberately;
   a smoke test asserts its absence.
5. **Keep cloud backup byte-compatible**: all durable state = `pb.*` localStorage
   keys through the `LS` adapter (app.js:37); backup is "all `pb.*` minus
   `BACKUP_SKIP`". Never bypass `LS`, never change stored formats without a
   `LEGACY_KEY_MAP` migration.
6. **`backend/worker.js` is canonical** (no root copies). `worker.js` and `sw.js`
   must NOT import `pb-data.js` (browser-only). `pb-core.js` is the single source
   of truth for market hours / alert eval / symbols / money math.

## The wiring checklist (miss one and the live site breaks)

Any change to shipped files → **bump `CACHE_NAME` in sw.js** (currently
`playbook-shell-v91`), or installed PWAs serve stale assets offline.
(`LOGO_CACHE` is separate and `node tools/build-logos.mjs` bumps it itself — logo
filenames are stable across rebuilds and `/logos/` is served cache-first, so a
rebuilt pack would otherwise never reach an installed PWA.)

Rebuilding the **logo pack** (`node tools/build-logos.mjs`) also needs `LOGO_CACHE`
bumped in sw.js: `logos/*.png` are served cache-first under stable filenames, so
without it every installed PWA keeps the old marks forever.

Adding a **new runtime file** additionally requires ALL of:
1. `<script>` tag in `index.html` (real order, verified: pb-core → pb-data → pb-store →
   pb-content → pb-import → **pb-views → pb-modals** → data.js → demo-data.js → app.js —
   pb-core first, always; app.js last. The buckets load BEFORE data.js, which is why they
   read `DATA`/`PB_DATA` at render time rather than at IIFE top);
2. `sw.js` `SHELL_ASSETS` entry + cache bump;
3. `.github/workflows/static.yml` — BOTH the `cp` list AND the Guard-1 loop;
4. the 16 app-mounting `backend/test/verify-*.mjs` harness shells (each embeds its
   own `<script>` list).
`demo-data.js` currently violates #3 — that's GAPS.md #1, don't copy that pattern.

## Conventions

- **No JSX anywhere** — hand-written `React.createElement`. Match it.
- **New shared module** = dual-mode classic script: IIFE + `module.exports` +
  `globalThis.PBX`; app.js binds via `const x = PBX.x` at the old definition site.
  Prefer extending an existing pb-* file over adding a new script (see checklist).
- **State**: durable settings → `SETTINGS_SCHEMA` + `useSetting`; durable
  collections → `PORTFOLIO_SCHEMA` + `useCollection`; prices → `PBStore` only
  (`mergePrices` is a shallow merge — untouched quotes MUST keep their object
  reference, that's what makes `React.memo` work). Raw `usePersistedState` is for
  view-local UI state only. Volatile/re-derivable keys go in `BACKUP_SKIP`.
- **Mutators return `{ok, code, ...}` outcomes — never call toast in the data
  layer.** All user-facing copy lives in `describeOutcome` (app.js:2528); wire new
  mutators through `useToastEvents` at the App edge.
- **Tests**: characterization first, then move code; add an anti-drift source guard
  (tests grep app.js/worker.js to assert delegation, e.g. no `function centDivisor`
  reappears). Node suites never load app.js — extraction bugs only show in the
  browser smoke.
- **Refactor workflow**: each increment gets a spec + plan under
  `docs/superpowers/`, built branch-per-increment off latest `origin/main`.

## Gotchas (things that look right but aren't)

- **Encoding**: app.js has a BOM and **LF** line endings (measured: 0 CRLF — an older note here said
  CRLF, it is wrong); `£ € · —` are authored as `\uXXXX` ASCII
  escapes. The Edit tool decodes typed `\uXXXX` into literal glyphs — you cannot
  retype these strings. Move content with Node slice scripts (read → splice →
  write). In Node scripts, a `.replace()` search spanning a line break needs
  `\r?\n` or it silently no-ops.
- **`node --check` + green node suites can still mean a broken app** (e.g. app.js
  referencing a const you moved out). Always run
  `verify-refresh-behavior.mjs` after touching module boundaries; also sanity-check
  `node -e "console.log(typeof require('./pb-core.js').fnYouAdded)"`.
- **`window.PBCore`/`PBData`/`PBStore`/`PBContent`/`PBImport` must exist before
  app.js runs.** The `const X = PBCore.X` binds are TDZ-safe only because every
  call site is inside a function body.
- Import matching: `IMPORT_SYNONYMS.total` has **no bare "total"**; "Book Cost" is
  deliberately claimed as a TOTAL column, not per-share cost.
- `marketOpen` **fails open** (returns true) if Intl throws; CRYPTO is always open.
- The live Worker runs an older bundle until Jan redeploys (GAPS.md #3) — don't
  chase "server fired a weird alert" bugs in repo code first.
- Git history was **rewritten 2026-06-28** (secret purge) — pre-rewrite SHAs in old
  notes may not resolve.
- `pb.iconTheme.v1` is also written by inline script in `index.html` (before React
  loads) — it has two writers, mind both when touching icon theming.
- Yahoo pence/cents: JSE quotes arrive in cents (`ZAc`/`ZAX`), LSE in pence
  (`GBp`/`GBX`, and bare `GBP` on LSE is treated as pence too) — `centDivisor`
  in pb-core handles it; never hand-divide by 100 elsewhere.

## Current state (2026-07-26)

> ## ✅ THE REFACTOR IS COMPLETE. **Phase 5 is CLOSED — do not implement it.**
>
> Phases 0-4 are done and verified; **Phase 5 (IndexedDB) was closed 2026-07-26 by Jan's decision
> (Option A, resolved by evidence)** — measurement showed no size ceiling (**261 KB = 5.1%** of the
> 5 MB budget) and that ITP evicts IndexedDB too, so the swap fixes nothing it was proposed for.
> **No Phase 5 code was ever written and none should be.** If a doc or a memory tells you to start
> it, that doc is stale — the evidence is in
> `docs/superpowers/specs/2026-07-25-phase-5-indexeddb-storage-design.md`, and the bar for
> reopening is that spec's appendix footprint script reporting >~1 MB on Jan's real device.
>
> **➡️ The next phase is [SECURITY_ROADMAP.md](SECURITY_ROADMAP.md)** — now unblocked (its Phase 5
> storage prerequisite was rewritten; Roadmap Phase 3 owns that work and it reduces to quota
> handling + diagnostics). Residual small items live in [GAPS.md](GAPS.md).

Refactor Phases 0-3 complete. **Phase 4 view/modal extraction is COMPLETE — the `window.PBApp` bridge has
reached its floor (38 members)** as of **inc-35**, and inc-36 **verified that floor member-by-member**
(the previous three increments each corrected an unverified "floor reached" claim; this one enumerated all
38 and counted real callers — it holds). The living roadmap a fresh chat should read is
**[docs/superpowers/REFACTOR_STATUS.md](docs/superpowers/REFACTOR_STATUS.md)**. `pb-views.js` holds all 11
tab views + the Heatmap cluster + the growth-chart cluster; `pb-modals.js` holds all 11 modals (incl. the
three rule-#3 money modals) + the detail/settings subtrees + `SectorWeightRows` + `useSwipeDownToClose` +
`fetchSectorTrend`. Every bridge member is genuinely shared across both buckets, consumed by the root `App`,
or an impure/anchored reader coupled to `DATA`/root infra.

**inc-36** then closed **GAPS #7** by moving the FX providers (`fetchFxRates`/`fetchHistoricalFx` +
`FX_PROXIES` + `HISTORICAL_FX_CACHE`) into `pb-data.js` — **app.js now contains no network code** (5037 ->
4999 lines). `DISPLAY_CURRENCIES` is injected via `PBData.configure` (pb-data is dual-mode and must never
read `PBContent`). A follow-up commit closed **GAPS #7's second half**: the FX readers now share the
app-wide `pLimit(8)` gate + in-flight de-dupe, but deliberately still do NOT call `fetchViaProxies` (that
path is proxy-only, hard-codes `no-store`, and returns text — the FX cache modes are load-bearing).
**inc-37** closed the **GAPS #9 interim task by correcting its premise**: the `pb.prices.v1` write was
**already debounced** (since the repo's first commit — both merge paths rode it, and `onBatch` fires once
per 8-symbol batch, so a sweep always collapsed to one `JSON.stringify`), so the stringify-per-merge perf
cost GAPS described never existed. The real defects were durability ones — no flush on hide/unmount (iOS
kills pending timers on a backgrounded PWA, losing the last sweep), no max-wait, and a stale-snapshot
capture — all three now fixed behind `PBStore.createWriteScheduler` in `pb-store.js`, with the 1200 ms
quiet period proven unchanged by a 7-scenario characterization matrix
(`backend/test/write-scheduler.test.mjs`, 36 tests; suite 29 -> 30). app.js 4999 -> 5025 lines.
`sw` `CACHE_NAME` = `playbook-shell-v91` (instrument logos, rev 2 —
see [docs/superpowers/LOGOS_STATUS.md](docs/superpowers/LOGOS_STATUS.md)).

**inc-38** spec'd **Phase 5** and stopped at the gate: it touches rule #5, so it needs Jan's sign-off
before any code, and none was written. Checking the premise first killed it —
`docs/superpowers/specs/2026-07-25-phase-5-indexeddb-storage-design.md` shows the app uses **261 KB =
5.1%** of the 5 MB localStorage budget (**812 KB / 15.9%** on a 5-year model), so there is **no size
ceiling**; Safari's ITP evicts **IndexedDB too** (and exempts installed PWAs), so the substrate swap
doesn't fix the eviction risk either; and the "seam already exists" claim is false — **three paths
bypass `LS`** (`gatherBackup` enumerates, `applyBackup` writes raw strings, `pb-data.js:142/154`) plus
`index.html:33/38`. The real problem is that `LS` is **synchronous and read at module-eval time** while
IDB is async. **Four options went to Jan; he chose Option A — close it. See the banner above.**
inc-38 also landed the pin Phase 5 needed under any option:
`backend/test/backup-roundtrip.test.mjs` (21 tests, suite 30 -> 31) tests the **real** `app.js` backup
block via a `vm` slice, closing GAPS #13's backup half — and it caught `verify-cloud-backup.mjs` having
drifted (7-key vs 9-key `BACKUP_SKIP`; the legacy-restore branch untested anywhere). Also corrected:
there are **44** `pb.*` keys, not 40 — `pb-views.js` owns 8 the schemas don't list.

**inc-39 closed the refactor.** Jan reviewed inc-38's measurements and **closed Phase 5 (Option A)**;
every doc that promised IndexedDB was corrected (`GAPS.md` #9, `PROJECT.md`, `REFACTOR_STATUS.md`, the
spec + plan, and the **four** `SECURITY_ROADMAP.md` references that treated refactor Phase 5 as the
canonical home for roadmap storage work — that roadmap would otherwise have started blocked on a phase
that will never run). It also cleared the last two unblocked GAPS items and took the **one** durable
action item out of the Phase 5 spec: `pb.tfsa.targets.v1` + `pb.tfsa.contribution.v1` were
user-entered planning data stored with the **view-local-UI idiom** (raw `usePersistedState`), riding
cloud backup only by accident of the `pb.` prefix rule — both now live in `PORTFOLIO_SCHEMA` beside
`tfsaDeposits`. **`PORTFOLIO_SCHEMA`, not `SETTINGS_SCHEMA`**: `setTargets` is called with an updater
function and only `setCollection` accepts one. The other six unschema'd `pb-views.js` keys are
genuinely view-local and correctly stay put. **Bridge unchanged (38)**; rule #5 proven by a
before/after render probe with an **identical digest** plus a write-path probe whose stored JSON is
byte-identical to the same probe on pristine code. `CACHE_NAME` -> **v89**.

inc-39 also closed the last two GAPS items. **#13**: `hot-topics-dates.test.mjs` (8 tests) pins the
`toISOString` day-roll trap in positive-offset zones (re-run in 3 zones via `TZ` re-spawn) and the
**DST** trap — `2026-03-08->09` is empirically a **23-hour** day, so `Math.floor` would render
tomorrow's earnings as "today"; `describe-outcome.test.mjs` (18 tests) adds a bidirectional
code<->case guard (a returned code with no `case` is a *silent missing toast*) and **found nothing
wrong** — 37/37, zero orphans. Suite **31 -> 33**. **#12**: the CDP "Execution context destroyed"
flake is **structural**, not luck (Chrome destroys the `about:blank` context when the harness URL
commits, and harnesses attach in exactly that window — pristine `verify-indicators` failed 3/3
here), and **the fix already existed** in `verify-refresh-behavior.mjs`, never propagated; it now
covers **16** harnesses (mount gate left untouched). `verify-indicators` Part B2 now seeds
`pb.ribbonItems.v1` before app.js evaluates (`Hero` takes only `onOpenDetail` — all three props it
was passed were ignored). The stale `verify-settings` scroll assertion was **unpassable in any
environment**: the scroller is `.modal-panel > .modal-body`, so querying `.modal-panel` made
overflow always 0 — and its partner assertion was passing vacuously.

**The pattern held to the very end: seven increments running, the written roadmap was wrong about
something load-bearing.** Phase 5's whole premise (inc-38), `PROJECT.md`'s Phase 4 status, GAPS
#12's "flake" (structural, and already fixed elsewhere in the repo), and GAPS #12(c)'s "one stale
assertion" (two — its partner was a false green). Every one was caught by a grep or a 30-line
script. **Measure the claim before building on it.**
