# GAPS.md — honest audit of every known weakness

*Written 2026-07-10 at commit `a39c791`. Ordered by severity, most important first.
Each entry: what it is, where it lives, why it matters, and a fix scoped small
enough to execute as a single task. Cross-references: [PROJECT.md](PROJECT.md) for
architecture, [SECURITY_ROADMAP.md](SECURITY_ROADMAP.md) for the larger security
plan (several items below are officially "owned" by that roadmap).*

---

## 1. `demo-data.js` is served locally but never deployed — breaks the live service worker

> **FIXED 2026-07-11** (branch `claude/mobile-preview-mode-error-q5kt2u`): `demo-data.js`
> added to both the `cp` list and the Guard-1 loop in `static.yml`; `CACHE_NAME` bumped
> to v51; and the class-killing guard test now exists as
> `backend/test/deploy-assets.test.mjs` (cross-checks sw.js `SHELL_ASSETS`,
> index.html `<script src>` tags, and the static.yml allowlist against each other).
> Entry kept for history until merged to main.

- **What**: `index.html:80` loads `./demo-data.js` and `sw.js` lists it in
  `SHELL_ASSETS` (sw.js:16), but `.github/workflows/static.yml` does **not** copy it
  into `_site/` (neither the `cp` list at line 44 nor the Guard-1 loop at line 50).
- **Why it matters**: on the live GitHub Pages origin, `demo-data.js` returns 404.
  `cache.addAll(SHELL_ASSETS)` rejects on any non-OK response, so **the service
  worker's `install` event fails on the live site** — every cache version since the
  file was added (v42, 2026-07-05) never installs. Consequences: installed PWAs are
  silently pinned to an old cache (the app still updates online because fetch is
  network-first, which is why nobody noticed), the offline shell goes stale forever,
  and the SKIP_WAITING update flow is dead. Separately, Preview mode has no demo
  data on the live site (guarded — app doesn't crash, but the feature is broken).
- **Severity**: **High** (silent production breakage of sw updates + a feature).
- **Fix (single task)**: add `demo-data.js` to both the `cp` list and the Guard-1
  loop in `static.yml`, bump `CACHE_NAME` to v51 in `sw.js`. Alternatively, if Jan
  decides Preview is local-only: remove it from `index.html` + `SHELL_ASSETS`
  instead. Either way, add a tiny node test that asserts every `SHELL_ASSETS` entry
  (and every `<script src>` in index.html) appears in static.yml — that kills this
  whole class of bug. (Tracked as postponed task F9.)

## 2. `sw.js` is a third, drifted implementation of fetch + alert evaluation

- **What**: `sw.js:204–292` contains its own `SW_PROXIES` (5 proxies vs pb-data's 6,
  different order/unwrap handling), `swYahooSymbol`, `swCentDivisor`, and
  `swEvaluate` — hand-ported copies of logic whose client/server drift was already
  fixed once by creating `pb-core.js`.
- **Why it matters**: it has **already drifted**. Concrete diffs vs `pb-core.js`:
  - `swYahooSymbol('^SPX')` → `%5ESPX` (wrong instrument); pb-core maps `^SPX` →
    `%5EGSPC` (pb-core.js:289) — the exact bug fixed in the Worker in Phase 1.
  - `swCentDivisor` lacks the `ZAX` code and the market-independent
    "trailing-lowercase GB*/ZA* = pence/cents" rule (pb-core.js:266-267); a mis-filed
    listing evaluates 100× off in background alert checks.
  - `swEvaluate` is semantically close to `PBCore.evaluateAlerts` but has no
    equivalence test, so nothing stops future divergence.
  Background-sync alerts (installed PWA, Android/desktop Chrome) can therefore fire
  differently from the foreground app and the server — the precise failure class
  the whole Phase-1 refactor existed to kill.
- **Severity**: **High** (correctness of a notification path; silent).
- **Fix (single task)**: service workers can load classic scripts — add
  `importScripts('./pb-core.js')` at the top of sw.js (pb-core sets
  `globalThis.PBCore`), replace `swYahooSymbol`/`swCentDivisor`/`swEvaluate` with
  the PBCore equivalents (the client-side stale-price drop isn't needed — the SW
  fetches fresh), keep the inline fetch chain, bump cache version. Add an
  anti-drift source guard to a node test asserting sw.js contains no
  `function swYahooSymbol/swCentDivisor/swEvaluate`. (Already flagged in
  SECURITY_ROADMAP Phase 1 as "sw.js pb-core drift fix".)

## 3. The live Cloudflare Worker still runs the pre-refactor bundle

- **What**: the repo's `backend/worker.js` imports pb-core (correct `^SPX`/`^VIX`
  symbols, correct JSE-ZAR unit handling), but the **deployed** Worker predates
  that. The static site auto-deploys on push; the Worker only deploys when Jan runs
  `cd backend && npx wrangler deploy` (needs his Cloudflare login).
- **Why it matters**: app-closed push alerts on index symbols (^SPX/^VIX) fetch the
  wrong instrument and JSE alerts whose Yahoo currency reports `ZAR` get divided by
  100 — the server can push alerts the app would never fire.
- **Severity**: **High if server push is in use**, otherwise dormant.
- **Fix**: Jan-only action: `cd backend && npx wrangler deploy --dry-run` (confirm
  the CJS import bundles), then `npx wrangler deploy`. (Postponed task #1.)

## 4. Every user symbol flows through 6 free public CORS proxies to an unofficial API

- **What**: all quotes go browser → third-party proxy (corsmirror, cors.lol,
  allorigins, corsproxy.io, codetabs…) → Yahoo v8 chart API. `pb-data.js` (client),
  `sw.js` (background). The proxies see the full symbol list; the API is unofficial
  and rate-limited; proxies flap (the code literally sniffs "Too Many Requests").
- **Why it matters**: **privacy** (a portfolio's tickers are sensitive), and
  **reliability** (stale/blank prices under proxy failures are the app's main
  quality complaint historically).
- **Severity**: **Medium-High**, by far the largest architectural liability.
- **Fix**: not a small task — this is SECURITY_ROADMAP Phase 1 (first-party
  Cloudflare quote-proxy Worker with edge caching/batching, then delete the proxy
  ladder). Don't attempt piecemeal; the roadmap doc has the design.

## 5. No CSP, and React comes from unpkg without integrity hashes

- **What**: `index.html:68-69` loads React 18.3.1 UMD from unpkg with no
  `integrity` attribute; Google Fonts likewise external; there is no
  Content-Security-Policy anywhere.
- **Why it matters**: an unpkg compromise or MITM = arbitrary code with access to
  the entire localStorage (portfolio, Perplexity API key, backup recovery-code
  bookkeeping). An unpkg outage = app fails to boot for uncached first-time visits.
  Any XSS foothold has no CSP backstop.
- **Severity**: **Medium** (low likelihood, total impact).
- **Fix (single task now)**: add `integrity="sha384-…" crossorigin` to the two
  React script tags (versions are pinned, so SRI is stable). Self-hosting React +
  fonts and adding a CSP meta tag is the fuller fix (roadmap Phase 1) — note the
  CSP must allow the CORS proxies until gap #4 is done.

## 6. Worker API is world-open: `Access-Control-Allow-Origin: *`, no rate limiting

- **What**: `backend/worker.js:28-33` — all endpoints, including `/backup` POST
  (write) and `/subscribe`, accept requests from any origin, any volume.
- **Why it matters**: KV free tier allows 1k writes/day; anyone who finds the
  Worker URL can exhaust that quota (breaking backup/sync for real devices), spam
  device records, or probe `/backup` keys (blobs are E2EE ciphertext, so
  confidentiality holds — this is an availability/abuse problem).
- **Severity**: **Medium** (requires knowing the personal Worker URL).
- **Fix (single task)**: pin `Access-Control-Allow-Origin` to the Pages origin,
  add a per-IP token-bucket (Workers `caches`/KV or Durable Object is overkill —
  a simple in-memory map per isolate + `cf-connecting-ip` cuts drive-by abuse),
  and cap `client:` record count. Roadmap Phase 1 lists the same.

## 7. FX fetching is the last network code still inside app.js

- **What**: `FX_PROXIES` (app.js:463), `fetchFxRates`, `fetchHistoricalFx`,
  `HISTORICAL_FX_CACHE` (app.js:~1100) — a second, parallel proxy ladder that
  never moved to pb-data.js (explicitly deferred in Phase 2/3).
- **Why it matters**: duplicate proxy logic can drift from the hardened
  `fetchViaProxies` (no in-flight de-dupe, no pLimit cap, separate error
  heuristics); it's also untested and keeps app.js impure.
- **Severity**: **Medium** (correct today; a drift and test gap).
- **Fix (single task, follows the established recipe)**: verbatim-move the FX
  block to pb-data.js (inject `DISPLAY_CURRENCIES` via `PBData.configure` like
  `indicatorCatalog`), bind in app.js, route through `pLimit`/de-dupe, add
  characterization tests + anti-drift guard, bump sw cache.

## 8. app.js is still a 12,289-line monolith (~50 components in one file)

- **What**: all views, all modals, all remaining hooks in one file; `App()`
  (app.js:2733) is still a ~770-line component; `SettingsModal` ~600 lines;
  `usePortfolio` a 440-line mega-hook.
- **Why it matters**: review/merge cost, cold-start parse cost (675 KB), and it
  blocks meaningful code-splitting. This is the *planned* next phase, not an
  accident — but it's still the biggest maintainability gap.
- **Severity**: **Medium** (chronic, not acute).
- **Fix**: don't freelance this. Next Phase-4 increment = first view/modal split,
  which forces the Vite-vs-no-build decision (Jan decides). Any single view
  (e.g. `RulesView`, `PicksView`, `HedgesView` — small, prop-light) is a
  reasonable pilot task once the module mechanism is chosen.

## 9. localStorage is the database (D2)

- **What**: 40 `pb.*` keys via the synchronous `LS` adapter; `pb.prices.v1` is
  re-stringified on every sweep; everything shares the ~5 MB quota; iOS can evict
  storage for uninstalled/rarely-used PWAs.
- **Why it matters**: main-thread JSON.stringify on every price merge (perf), a
  hard size ceiling as transactions/history grow, and total data loss on Safari
  eviction if cloud backup is off.
- **Severity**: **Medium** (works today at current data size).
- **Fix**: Phase 5 as planned (IndexedDB behind the existing `LS`-shaped adapter —
  the seam already exists because everything goes through `LS`). A small interim
  task: debounce/throttle the `pb.prices.v1` write (currently every sweep) — it's
  in `BACKUP_SKIP` so nothing downstream cares about write timing.

## 10. Perf debt inside the monolith: memoization is thin

- **What**: 187 `useState` / 70 `useEffect` / 2,059 `createElement` in one file;
  only 5 `React.memo` sites; most list children get freshly-built inline arrow
  props each render (only `HoldingRow`'s handlers were identity-stabilized).
- **Why it matters**: Phase 3 fixed the catastrophic case (whole-tree re-render per
  price batch). What remains is moderate: view-level re-renders on store changes
  are broader than necessary. Not user-visible today on an iPhone-class device.
- **Severity**: **Low-Medium**.
- **Fix**: fold into the component split (gap #8) — memoizing more leaves before
  the split would be rework. Don't spend time here first.

## 11. README.md has drifted again

- **What**: `README.md` file table (lines 52-64) omits all five `pb-*.js` modules
  and `demo-data.js`; says app.js is "~755 KB" (now 675 KB / 12,289 lines); GitHub
  Pages instructions say "Upload all 9 files".
- **Why it matters**: it's the first doc a stranger reads, and it contradicts the
  actual deploy (the allowlist ships 15 files + brand/). A manual "drag the folder"
  deploy per the README *works*, but a selective 9-file upload would produce
  exactly gap #1's class of breakage.
- **Severity**: **Low** (docs).
- **Fix (single task)**: update the file table to the current file list (copy from
  static.yml's allowlist), fix the size, replace "all 9 files" with "the runtime
  files listed below".

## 12. Stale/flaky test debt in the browser harnesses

- **What**: (a) `verify-indicators.mjs` Part B2 fails on baseline — it passes
  `ribbonItems` as a prop, but Hero self-subscribes via
  `PBStore.useSetting('ribbonItems')` since Phase 3 inc 2 and ignores the prop;
  it needs to seed `pb.ribbonItems.v1` in localStorage instead. (b) The
  screenshot-style harnesses (modals, sector-weights, holdings-redesign,
  goal-holdings) have a long-standing flaky CDP "Execution context destroyed"
  race. (c) `verify-settings` has one stale assertion ("Alerts: menu overflows").
- **Why it matters**: known-red tests train people to ignore red tests. The flake
  has already caused misattributed failures during increments.
- **Severity**: **Low-Medium** (test hygiene).
- **Fix (three tiny tasks)**: (a) seed the localStorage key in the harness shell;
  (b) add a retry-once wrapper around the CDP eval in the shared harness pattern;
  (c) update or delete the stale settings assertion.

## 13. No unit tests on the remaining in-app logic seams

- **What**: pure logic *outside* the extracted modules is untested: the FX fetch
  ladder (gap #7), `gatherBackup`/`applyBackup` round-trip, the backup crypto
  block (app.js:109-160, only exercised indirectly by `verify-cloud-backup.mjs`),
  Hot Topics date math (`hotToDate`/`hotDayDiff`, app.js:941+), and
  `describeOutcome` coverage is copy-only.
- **Why it matters**: backup/restore is the disaster-recovery path — a regression
  there is discovered exactly when it's most catastrophic. The 19 green suites
  create justified confidence *only* over pb-core/pb-data/pb-import/pb-store.
- **Severity**: **Low-Medium**.
- **Fix (single task)**: add `backup-roundtrip.test.mjs` vm-slicing (or extracting)
  `gatherBackup`/`applyBackup`/`LEGACY_KEY_MAP` with a fake localStorage — assert
  byte-identical round-trip incl. the SKIP set and legacy key migration.

## 14. `BUILTIN_MACRO_2026` goes silently stale on 2027-01-01

- **What**: the hand-written central-bank/macro calendar in `pb-content.js`,
  refreshed manually once a year.
- **Why it matters**: next January, Hot Topics quietly shows an empty/wrong macro
  schedule for users without a Perplexity key (the AI path supersedes it).
- **Severity**: **Low** (predictable, time-delayed).
- **Fix (single task)**: extend `content.test.mjs` with an assertion that the
  calendar's max date is ≥ ~90 days in the future — the suite then starts failing
  in ~October 2026 as a built-in reminder. Optionally render a "calendar may be
  out of date" hint in HotTopicsView when the newest entry is in the past.

## 15. Abandoned artifact: the GCP Worker migration plan

- **What**: `docs/superpowers/plans/2026-07-01-gcp-worker-migration.md` — a full
  plan to replace the Cloudflare Worker with Google Cloud Functions + Firestore.
  No matching spec, never executed; the Cloudflare Worker remains canonical.
- **Why it matters**: a future agent could reasonably conclude a GCP migration is
  in flight and start executing it.
- **Severity**: **Low** (confusion hazard only).
- **Fix (single task)**: Jan decides: delete it, or add a one-line header
  `> STATUS: not pursued (2026-07) — Cloudflare Worker remains canonical.`

## 16. Minor inconsistencies & cruft (batch these)

- **Two persistence idioms coexist**: schema-driven store slices vs. raw
  `usePersistedState` for view-local UI state (app.js:6167, 7562-7568, 8184-8185,
  and `useAlertEngine`/`useCloudBackup` internals). Intentional, but undocumented
  at the call sites — a newcomer can't tell which to use. Fix: one comment block
  above `usePersistedState` stating the rule ("view-local UI state only; durable
  domain state goes in a schema"). (Now also stated in CLAUDE.md.)
- **`launch.json` at repo root** — a default VS Code debug config, belongs in
  `.vscode/launch.json` or deleted. It is not deployed (not in allowlist). 
- **`test/` at repo root** contains only a stray `node_modules` (http_ece) left
  from the Phase-0 relocation of tests to `backend/test/`; gitignored but
  confusing on disk. Safe to delete the directory locally.
- **`tools/`** (`gen-light-icons.mjs`, `icongen`) is undocumented — one README
  line saying "one-shot icon generation scripts, not part of the app" would do.
- **Root worker duplicates** (the old A-audit finding) are confirmed gone; no
  action.
- **Severity**: **Low**.

## 17. Accepted risks (documented so nobody "fixes" them blind)

- **Perplexity API key in plaintext localStorage** (`pb.perplexityKey.v1`) —
  accepted trade-off for a no-backend app; the key is user-supplied and scoped to
  their own account. Revisit under roadmap Phase 2 (cloud accounts).
- **Personal content ships in the public bundle** — theses, price targets, the
  page title "Jan's 30% Target" (`data.js`, `index.html:5`). Jan knows; Preview
  mode exists for demoing, not for hiding the deploy.
- **`marketOpen` fails open** (pb-core.js:50): if Intl/timezone lookup throws, the
  market is treated as open (poll normally) — chosen so a platform quirk degrades
  to extra polling, not missed alerts.
- **Old Stooq cookie in GitHub's unreachable-object cache** — history was
  rewritten and force-pushed 2026-06-28; GitHub may retain orphaned commits until
  its GC runs. Accepted for a trivial guest cookie (rotation still on Jan's list).
