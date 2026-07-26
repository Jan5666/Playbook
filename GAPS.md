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

> **FIXED 2026-07-21** (branch `claude/refactor-plan-continuation-645imf`): `sw.js` now
> `importScripts('./pb-core.js')` and delegates symbol-building, the cent/pence divisor,
> and alert evaluation to `PBCore.yahooSymbol` / `PBCore.centDivisor` / `PBCore.evaluateAlerts`;
> the drifted `swYahooSymbol` / `swCentDivisor` / `swEvaluate` copies were deleted. This
> corrects the `^SPX`→`%5EGSPC` instrument and the missing-`ZAX` 100× mis-scaling in the
> background alert path. `swRunAlertCheck` now feeds `evaluateAlerts` a bare-number price map
> (its documented contract) with the 5-min SW cooldown passed explicitly. The inline
> `SW_PROXIES` fetch chain stays (pb-data.js is browser-only — rule #6). `CACHE_NAME`→v80.
> Anti-drift guard + a behavior pin live in `backend/test/sw-core-delegation.test.mjs`
> (asserts sw.js delegates and defines none of the three copies). Entry kept for history
> until merged to main.

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

> **FIXED 2026-07-25** (branch `claude/refactor-plan-continuation-gto2pa`, inc-36): the
> whole FX block (`FX_PROXIES`, `HISTORICAL_FX_CACHE`, `fetchHistoricalFx`, `fetchFxRates`)
> moved verbatim into `pb-data.js`; app.js keeps two binds (`const fetchFxRates =
> PBData.fetchFxRates;`) so its 4 call sites are unchanged, and `DISPLAY_CURRENCIES` is
> injected via `PBData.configure` like `indicatorCatalog`. Behaviour was pinned by a
> 14-scenario characterization matrix run against the app.js source *before* the move and
> against `PBData` *after* — byte-identical digests — now committed as
> `backend/test/fx-providers.test.mjs` (35 assertions incl. anti-drift guards).
> `CACHE_NAME` bumped to v87.
>
> **Second half done (same branch, follow-up commit):** the FX readers now share the
> app-wide `pLimit(8)` gate (via a small `fxFetch` helper) and collapse concurrent
> identical requests through in-flight maps. They still do **not** call `fetchViaProxies`,
> and that is deliberate — that path is proxy-only (it would drop the direct-first
> attempt), hard-codes `cache:'no-store'`, and returns text, whereas the per-request cache
> directive here is load-bearing (immutable historical rates are `force-cache`d). The
> characterization matrix was the guard: all 35 original assertions still pass unchanged
> and the before/after digest still matches the pre-move app.js exactly, with 9 new
> assertions covering the de-dupe and the concurrency cap (`max in flight = 8` for 20
> parallel lookups; it was unbounded before). Entry kept for history until merged to main.

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
- **Outcome (both halves done)**: `FX_PROXIES` remains a second, *intentionally* distinct
  ladder — direct-first, with per-request cache modes — but it is no longer an
  unsupervised one: it shares the `pLimit(8)` gate and the in-flight de-dupe, and it is
  now the best-tested network path in the codebase (44 assertions). The residual
  "duplicate proxy logic" is a deliberate, documented difference rather than drift.
- **Note on the original premise**: the fix line above assumed the missing `pLimit`/de-dupe
  was a live risk. Reading the call sites showed it was mostly latent — `fetchHistoricalFx`
  is called from a **sequential** import loop and from single user actions, and the
  completed-value cache already collapsed sequential repeats, so at most ~2 FX fetches were
  ever concurrent in practice. The cap is still worth having (it removes an
  unbounded-by-design path and future-proofs parallelising that loop) but it fixed a
  latent, not an active, problem.

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

> **RESOLVED BY EVIDENCE 2026-07-26 — Phase 5 closed (Option A), Jan's decision.**
> Not fixed by code: **measurement showed there was nothing to fix.** localStorage stays
> the database. The full reasoning is in
> [`specs/2026-07-25-phase-5-indexeddb-storage-design.md`](docs/superpowers/specs/2026-07-25-phase-5-indexeddb-storage-design.md);
> the three corrections below are why. The one real action item to come out of it —
> `pb.tfsa.targets.v1` + `pb.tfsa.contribution.v1` being user-entered data stored with the
> view-local-UI idiom — was fixed separately by moving both into `PORTFOLIO_SCHEMA`
> (2026-07-26). The remaining six unschema'd `pb-views.js` keys are genuinely view-local and
> correctly stay as they are. **Reopen only if** the appendix footprint script in that spec
> reports materially more than ~1 MB on Jan's real device.

- **What**: **44** `pb.*` keys (not 40 — 22 are schema'd, 8 more live only in
  `pb-views.js` via raw `usePersistedState`) through the synchronous `LS` adapter;
  everything shares the ~5 MB quota. Measured usage: **261 KB = 5.1%** of that quota.
- **Severity**: **Low** (downgraded from Medium — see the correction below). Now closed.
- **Fix**: **none needed.** Both original justifications failed measurement (1 and 2 below)
  and the migration was never as cheap as this entry implied (3 below). The residual
  boot-cost win Option B offered (~190 KB less synchronous parse at startup) was weighed
  and declined while app-open performance is acceptable.

**Correction (2026-07-25, Phase 5 spec).** This entry used to claim "a hard size
ceiling as transactions/history grow, and total data loss on Safari eviction if
cloud backup is off", with the fix being "Phase 5 as planned (IndexedDB behind the
existing `LS`-shaped adapter — the seam already exists because everything goes
through `LS`)". **All three parts were checked and none survived:**

1. **There is no size ceiling in sight.** Modelled from the real stored shapes and
   the real `data.js` constituent lists: **261 KB today** (all tabs visited, 300
   transactions, 500 cached names) = **5.1%** of a 5 MB budget; **812 KB** on a
   5-year model (3,000 transactions) = **15.9%**. The two "churny blobs" are
   bounded by construction (keyed by exchange id, and there are exactly 9
   exchanges → ~160 KB combined, forever). The only unbounded slices are
   transactions (159 bytes each) and nameCache (30 bytes each) — roughly **27,000
   transactions** to reach half the budget. Also verified: heatmap quotes never
   enter `pb.prices.v1` (`HeatmapView` never calls `mergePrices`), so 440
   constituents cost one bounded blob, not 440 persisted quotes.
2. **IndexedDB would not fix the eviction risk.** Safari's ITP evicts *all*
   script-writable storage — localStorage, **IndexedDB**, Cache API and SW
   registrations alike — after 7 days without interaction; home-screen-installed
   web apps are exempt. So for an installed PWA the risk largely does not apply,
   and where it does, migrating substrate does not reduce it. The encrypted cloud
   backup remains the correct mitigation, and it already ships.
3. **The seam does not already exist.** Three paths bypass `LS` and hit
   `localStorage` directly — `gatherBackup` (enumerates; `LS` has no `keys()`),
   `applyBackup` (writes raw strings; `LS.set` would re-stringify), and
   `pb-data.js:142/154` (`pb.nameCache.v1`) — plus `index.html:33/38`, which reads
   and writes `pb.iconTheme.v1` in an inline script before any module loads and is
   synchronous by requirement. CLAUDE.md rule #5's "all durable state … through the
   `LS` adapter" is aspirational, not descriptive.

The real engineering problem is neither size nor eviction: it is that `LS` is
**synchronous and consumed at module-eval time** (`app.js:2673`/`:2692` seed 22
slices before mount; 17 `usePersistedState` call sites read synchronously during
render) while IndexedDB is async. The only shape that preserves those call sites is
hydrate-at-boot into an in-memory mirror. Two things already exist that make the
narrow option cheap: the pre-React splash (`#pb-splash`) is a ready-made hydration
gate, and inc-37's `PBStore.createWriteScheduler` is already the bounded, flushable,
`pagehide`-safe write-behind path.

**Correction (inc-37, 2026-07-25).** This entry used to claim `pb.prices.v1` "is
re-stringified on every sweep", costing a main-thread `JSON.stringify` on every
price merge, and proposed "debounce/throttle the write" as an interim task. **That
was wrong and has been removed from the text above.** `usePriceFeed` has debounced
the write since the repo's first commit (`2de0e16`), both merge paths ride it, and
`fetchQuoteBatch` emits `onBatch` once per 8-symbol batch — so a whole sweep
already collapsed into a single write. There was no perf problem to fix.

What the debounce *did* get wrong was durability, and inc-37 fixed all three:
1. **no flush on hide/unmount** — iOS kills pending timers on a backgrounded PWA,
   so a sweep landing within 1.2 s of the user swiping away was silently lost;
2. **no max-wait** — a merge stream arriving faster than 1200 ms deferred the
   write forever (bounded in practice only by network latency, by accident);
3. **stale-snapshot capture** — the map was captured at schedule time, correct only
   because every merge path happened to re-schedule.

The logic now lives in `PBStore.createWriteScheduler` (`pb-store.js`), pinned by
`backend/test/write-scheduler.test.mjs` (36 tests on a fake clock, including a
7-scenario characterization matrix proving the quiet-period timing is unchanged).
**The interim task is closed**; the Phase 5 IndexedDB work is closed too (see the
resolution note at the top of this entry), so **this entry is fully closed**.

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

> **FIXED 2026-07-26** (branch `claude/refactor-plan-phase-5-3n3fvo`): all three tasks done,
> each verified against a **pristine `HEAD`** baseline first so a container artifact could not
> be mistaken for a real defect. That discipline mattered — see (b).
>
> **(a) `verify-indicators` Part B2.** Confirmed exactly as described: `Hero` takes **only**
> `onOpenDetail` as a prop (`app.js:3538-3544`) and self-subscribes `ribbonItems`, `ribbonMode`
> **and** `prices` from `PBStore`, so all three props the harness passed were silently ignored.
> Baseline printed `pills: ["S&P","VIX"]` — the schema **defaults**, not the 5 items under test.
> Since `PBStore.configureSettings` seeds from localStorage at app.js **eval** time, the fix is
> an inline `<script>` in the harness shell that writes `pb.ribbonItems.v1` + `pb.ribbonMode.v1`
> **before** the app.js `<script>`; prices go in through `PBStore.mergePrices` (they live in the
> store, not localStorage). Now prints all 5 pills and the CPI click fires
> `onOpenDetail("CPI","MACRO")`. **13 FAILs → 11**, exactly the 2 ribbon ones. (The other 11 are
> FRED/macro network failures in this container, not stale tests — untouched.)
>
> **(b) The CDP "Execution context destroyed" race — root-caused, and the fix already existed.**
> Not really a flake: Chrome creates an execution context for the initial `about:blank` and
> destroys it when the harness URL commits, and every harness attaches as soon as `/json` lists
> the target — *exactly* that window. So it is **structural**, and on a loaded machine it
> reproduces every run (pristine `verify-indicators` failed **3/3** here before any change —
> which is also what exonerated the (a) edit when it appeared to have broken the run).
> **`verify-refresh-behavior.mjs` — the one harness CLAUDE.md calls reliable — has carried this
> exact retry all along**, with the same diagnosis in its comment; it was simply never
> propagated. That retry is now standardized across **16** harnesses (each keeping its own
> timeout default and `exceptionDetails` formatting): 3 attempts, escalating backoff, and it
> retries **only** the transient CDP error, never a page exception — re-running an expression
> with side effects would be wrong, while a destroyed context ran nothing. The mount gate is
> deliberately **left untouched** (already correct, and it is the one harness that must not
> break); `verify-cloud-backup.mjs` has no CDP. Result: `verify-indicators` completes 3/3 where
> it previously died 3/3; mount gate still **ALL PASSED**; `verify-watchlist` ALL PASSED;
> `verify-modals` completes. **Honest limit:** a flake fix cannot be *proven* by sampling —
> `verify-sector-weights` failed 1 of 2 pristine runs and passes 2/2 now, which is suggestive,
> not conclusive. The `verify-indicators` 3/3-to-3/3 flip is the hard evidence.
>
> **(c) The stale `verify-settings` assertion — it could never have passed.** The scroll
> container is `.modal-panel > .modal-body` (`styles.css:915`, `overflow-y: auto`), **not**
> `.modal-panel`, which is a non-scrolling flex column. Querying the panel meant
> `scrollHeight - clientHeight` was **always 0** and `scrollTop = N` was **always a no-op**, in
> every environment — and the partner assertion "menu scrolls back to top" was therefore passing
> **vacuously** (`scrollTop === 0` because it never moved), which this entry had not noticed.
> Retargeted at the real scroller: baseline `{overflow:0,down:0,up:0}` → `{overflow:691,down:691,up:0}`,
> both assertions now meaningful. `verify-settings` **2 FAILs → 1**; the remaining "app mounted"
> failure is pre-existing in this container and out of scope.
>
> Test-only change — no shipped file touched, so **no `CACHE_NAME` bump owed** (`sw.js` stays
> **v88**). Node suite unaffected: **33/33**, money gate green.

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

> **BACKUP HALF FIXED 2026-07-25** (branch `claude/refactor-plan-continuation-qws8g3`):
> `backend/test/backup-roundtrip.test.mjs` (**21 tests**, node suite 30 → 31) now pins
> `gatherBackup`/`applyBackup`/`LEGACY_KEY_MAP`/`LS` against the **real `app.js` source**
> — sliced out by source marker and run in `node:vm` over a fake `localStorage`, since
> Node suites never load app.js. Covers the byte-identical round-trip, raw-string
> capture, the 9-key skip set, prefix filtering, overwrite-not-merge, **all 8 legacy
> `LEGACY_KEY_MAP` fields**, partial legacy exports, envelope-beats-legacy precedence,
> the `-1` rejection paths, foreign keys being dropped from a backup file, corrupt-JSON
> fallback, `_backupNotify` firing for durable `pb.*` only (set *and* remove), and
> quota failure returning `false` instead of throwing.
>
> **It also found live drift.** `verify-cloud-backup.mjs` hand-mirrors both functions
> ("kept identical on purpose") and had diverged: its `BACKUP_SKIP` listed **7** keys
> vs app.js's **9** (missing `pb.rotation.lastgood.v1` and `pb.hotStocks.v1`), and its
> `applyBackup` omitted the **entire legacy branch** — so the path that exists so old
> backup files still restore had zero coverage anywhere. The skip set is corrected and
> is now pinned by a guard that fails if the two ever diverge again; the legacy branch
> is covered properly by the new suite. That harness stays the authority on the
> AES-GCM/PBKDF2 crypto, which is its real subject. Test-only change — no `CACHE_NAME`
> bump owed. (The FX ladder sub-item is closed by gap #7.)
>
> **FULLY FIXED 2026-07-26** (branch `claude/refactor-plan-phase-5-3n3fvo`): the last two
> sub-items are done, both using the same `node:vm` source-slice pattern (suite **31 → 33**).
>
> **`backend/test/hot-topics-dates.test.mjs`** (8 tests) pins `hotToDate`/`hotDayDiff`/
> `hotDateKey` on the two traps they actually sit on. (a) **UTC-offset day rolling**: the
> source comment says `hotDateKey` must never use `toISOString()`, because local midnight
> of the 26th is 22:00 UTC on the 25th in SAST (UTC+2) — Jan's own zone — so ISO formatting
> would render every event a day early. Nothing enforced that; now a guard rejects
> `toISOString` in the block (checking code, not the warning comment) and the round-trip is
> re-run in **three zones** by re-spawning the file with `TZ` set (Africa/Johannesburg, UTC,
> America/Los_Angeles). (b) **DST**: `hotDayDiff` divides a ms delta by 86,400,000 and
> **rounds**. Verified empirically that 2026-03-08→09 is a **23-hour** day in US Pacific
> (0.958 days) and 2026-11-01→02 is **25** — so `Math.floor` would report tomorrow's
> earnings as **"today"**. That rounding is now pinned in both directions. `hotDayDiff` reads
> `new Date()` internally with no injection seam, so the vm context gets a `Date` **subclass**
> frozen at a chosen instant — real timezone/DST arithmetic, fixed "now". Also pinned as
> characterization: the regex validates **shape, not range**, so `'2026-13-01'` is accepted
> and rolls into 2027 — current behaviour, recorded so adding validation is a deliberate act.
>
> **`backend/test/describe-outcome.test.mjs`** (18 tests) pins the 14 parameterized branches
> (`1 position` vs `2 positions`, `entry`/`entries`, the `list === 'default'` fork, the
> `isIOS` fork, the `detail || 'error'` and `status || '?'` fallbacks — including that
> `status: 0` is falsy and falls back) plus the four non-ASCII copy strings, asserted via
> `\uXXXX` escapes so a re-encoding of `app.js` fails loudly. Its real value is the
> **bidirectional correspondence guard**: a returned code with no `case` is a *silent missing
> toast* (the action works, the user sees nothing) and a `case` with no producer is dead copy,
> and neither is visible from either file alone. **Honest read-out: this one found nothing** —
> 37 producers, 37 cases, zero orphans both ways. Unlike the backup suite it pins a clean
> state rather than fixing a broken one. Two apparent orphans were investigated and are not
> orphans: `position-added`/`shares-added` come from a **ternary** at `app.js:2212`, which is
> why the extractor captures the whole `code:` expression rather than a quoted literal.
> **This entry is now closed.**

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

## 18. stockanalysis.com's symbol API died upstream (added 2026-07-12)

- **What**: every `stockanalysis.com/api/symbol/{s,q}/...` path returns
  `{"status":404}` as of 2026-07-12 (verified direct AND via every proxy; only
  `/api/quotes` survives, which has no fundamentals). The site also serves
  `Access-Control-Allow-Origin: *` again, flipping PR #22's premise back.
- **Why it matters**: stockanalysis was the only free source for analyst
  targets, consensus, sector/industry and earnings dates. Those fields are now
  absent from the stock card (the Yahoo `fundamentals-timeseries` source covers
  the valuation/statement ratios); the sector self-heal and the Hot Topics
  US earnings sweep silently return nothing. The Perplexity fallback fills
  fundamentals only when a key is set.
- **What was done (2026-07-12)**: the dead endpoints are now probed with ONE
  direct time-boxed request (`fetchJsonDirect`, 4s abort) instead of the
  6-proxy cascade — two dead URLs through the chain took ~25s inside the
  `Promise.all` gating the card's stats render, which was the "missing
  fundamentals" bug, and hammered shared-proxy rate limits. The probe
  self-heals if the API returns. Guard: `fundamentals-parse.test.mjs`.
- **Update (2026-07-12, later)**: analyst targets + consensus are RESTORED via
  stockanalysis.com's `/forecast/` SvelteKit page-data (`__data.json`), which
  still ships the S&P Global consensus (price targets, ratings) even though
  the API tree is dead. That endpoint sends no ACAO header, so - unlike the
  dead API probes - it rides the proxy chain, with an outer 12s time-box so it
  can never re-create the render stall. See
  `docs/superpowers/specs/2026-07-12-analyst-consensus-targets-design.md`,
  parser `PBCore.parseSAForecast`, guards in `sa-forecast-parse.test.mjs`.
- **Severity**: **Low/Medium** (remaining loss: sector/industry self-heal,
  earnings dates, Hot Topics US earnings sweep; the stats block works via
  Yahoo timeseries and analyst targets via the forecast page-data).
- **Fix (single task)**: find a replacement source for sector/industry +
  earnings dates (candidates: the same `/forecast/`-style page-data for the
  overview page; Yahoo `v10 quoteSummary` with a crumb fetched through the
  Worker; Finnhub/FMP free tiers with a key in Settings), or accept
  Perplexity as the enrichment path.
