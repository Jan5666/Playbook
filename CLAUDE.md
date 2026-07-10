# CLAUDE.md — Playbook

Personal investment-tracking PWA (React 18 UMD, **no build step, no JSX**), deployed
to GitHub Pages, with an optional Cloudflare Worker for push + encrypted backup.

- **[PROJECT.md](PROJECT.md)** — architecture, data flow, design decisions, critical paths. Read before any structural change.
- **[GAPS.md](GAPS.md)** — every known weakness, ranked by severity, each with a scoped fix.
- **[SECURITY_ROADMAP.md](SECURITY_ROADMAP.md)** — the post-refactor security/platform plan (do not start it before the refactor phases finish).
- **docs/superpowers/{specs,plans}/** — the spec + plan for every refactor increment; the written history of why each seam exists.

## Commands

There is **no build, no lint, no npm scripts** at the root.

```bash
# Run the app: serve the repo root over HTTP (any static server), open index.html
npx serve .                       # or: python -m http.server

# Unit tests — zero-framework Node scripts, run individually (cwd doesn't matter):
node backend/test/money-math.test.mjs
for f in backend/test/*.test.mjs; do node "$f" || break; done   # full suite (19)

# MONEY GATE — must be green on ANY change touching money/import code:
#   money-math, cost-basis, import-matching, ee-ocr-parse

# Browser smoke (spawns local Chrome + HTTP server, mocks Yahoo). THE mount gate:
node backend/test/verify-refresh-behavior.mjs
# Reliable smokes: verify-refresh-behavior, verify-watchlist, verify-settings.
# Screenshot-style harnesses (modals/sector-weights/holdings/goal-holdings) have a
# PRE-EXISTING flaky CDP "Execution context destroyed" race — rerun before blaming
# your change. verify-indicators' 2 ribbon FAILs + verify-settings' "Alerts: menu
# overflows" are known-stale (GAPS.md #12). Chrome path is hardcoded:
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
`playbook-shell-v50`), or installed PWAs serve stale assets offline.

Adding a **new runtime file** additionally requires ALL of:
1. `<script>` tag in `index.html` (order: pb-core → pb-data → pb-store →
   pb-content → pb-import → data.js → demo-data.js → app.js — pb-core first, always);
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
  layer.** All user-facing copy lives in `describeOutcome` (app.js:2499); wire new
  mutators through `useToastEvents` at the App edge.
- **Tests**: characterization first, then move code; add an anti-drift source guard
  (tests grep app.js/worker.js to assert delegation, e.g. no `function centDivisor`
  reappears). Node suites never load app.js — extraction bugs only show in the
  browser smoke.
- **Refactor workflow**: each increment gets a spec + plan under
  `docs/superpowers/`, built branch-per-increment off latest `origin/main`.

## Gotchas (things that look right but aren't)

- **Encoding**: app.js has a BOM + CRLF; `£ € · —` are authored as `\uXXXX` ASCII
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

## Current state (2026-07-10)

Refactor Phases 0–3 complete; Phase 4 content extraction complete (increments 1–6
merged). **Next planned work**: first view/modal component split (forces the
deferred Vite-vs-no-build decision — Jan decides), then Phase 5 (IndexedDB).
Highest-value quick fixes live at the top of [GAPS.md](GAPS.md) (#1 demo-data.js
deploy gap, #2 sw.js drift, #3 Worker redeploy).
