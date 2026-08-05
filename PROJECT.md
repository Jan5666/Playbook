# PROJECT.md — Playbook

*The project overview a senior engineer would give a new hire. Written 2026-07-10 at
commit `a39c791` (main). For known problems see [GAPS.md](GAPS.md); for day-to-day
operational rules see [CLAUDE.md](CLAUDE.md); for the future security plan see
[SECURITY_ROADMAP.md](SECURITY_ROADMAP.md).*

---

## 1. What this is

**Playbook** is a personal investment-tracking Progressive Web App, built by and for
Jan — a South African investor holding US equities, JSE (Johannesburg) shares, a TFSA
(South African tax-free savings account), and crypto. It is installed to an iPhone
home screen and used daily. A "Preview mode" with demo data exists so the app can be
shown to other people without revealing real holdings.

What it does:

- **Live prices & P/L** for positions and watchlists across 9 market buckets
  (US, JSE, TFSA, LSE, ASX, FRA, PAR, AMS, CRYPTO), polled from Yahoo Finance's
  unofficial chart API through rotating public CORS proxies, with market-hours-aware
  cadence (slows to 5-minute polls when every tracked market is closed).
- **Multi-currency money math**: display currency is switchable (USD/ZAR/GBP/EUR…);
  cost basis is stored in the market's native currency with the FX rate locked at
  purchase ("FX at cost"); deposit-based profit tracking uses the actual USD landed
  at the locked deposit rate.
- **Price alerts** with three delivery tiers: in-app (app open), Periodic Background
  Sync via the service worker (installed PWA, mainly Android), and true server push
  via an optional Cloudflare Worker (works on iPhone even with the app fully closed).
- **Portfolio analytics**: sector donut with fund look-through weights, market
  heatmaps, portfolio value line chart vs. contributions, FX summary, TFSA
  contribution planner against the annual SA limits.
- **The playbook itself**: hand-written investment theses, trim levels, thesis-break
  triggers and rules (in `data.js` + `pb-content.js`), plus a Hot Topics tab
  (earnings countdown, central-bank calendar, AI-surfaced news via Perplexity when a
  key is set).
- **Broker import**: paste/CSV/XLSX/PDF import with fuzzy symbol matching, plus an
  OCR pipeline that parses EasyEquities app screenshots into positions.
- **Zero-knowledge cloud backup**: all local data encrypted client-side (AES-GCM,
  key derived from a 12-char recovery code) and stored as an opaque blob in the
  Worker's KV. The server can never read a portfolio.

Everything the user enters lives in `localStorage` on the device. There are no
accounts and no server-side plaintext.

## 2. Tech stack and why

| Piece | Choice | Why (inferred/documented) |
|---|---|---|
| UI | React 18.3.1 **UMD from unpkg CDN**, hand-written `React.createElement` — **no JSX, no build step** | The app must deploy by dragging a folder onto Netlify/GitHub Pages. No toolchain to install, no compile step to break. This constraint is deliberate and has been re-affirmed repeatedly during the refactor (the Vite decision is consciously deferred — see §5). |
| Shared logic | Plain "classic scripts" with a **dual-mode footer** (`globalThis.X` for the browser + `module.exports` for Node/Worker) | Lets pure logic be unit-tested in Node and imported by the Cloudflare Worker while still loading via `<script src>` with zero tooling. |
| State | Hand-rolled ~50-line store (`pb-store.js`) wired via `useSyncExternalStore` | A store was needed to stop whole-tree re-renders on every price batch; Zustand would have meant another CDN dependency. |
| Persistence | `localStorage` under `pb.*` keys, one key per slice | Simple, synchronous, survives PWA restarts. 44 keys, measured at ~261 KB — **5.1% of the 5 MB budget**, so the long-assumed scaling limit is not near (GAPS.md #9 corrected 2026-07-25). **IndexedDB was evaluated and rejected** (refactor Phase 5, closed 2026-07-26): no size ceiling to lift, and ITP evicts IndexedDB too. This is the permanent answer, not an interim one. |
| Prices | Yahoo v8 chart API (unofficial) via 6 rotating public CORS proxies; Stooq fallback; FRED/Morningstar/RSS2JSON/Perplexity for indicators/funds/news | Free. No API keys for core function. The fragility and privacy cost of the public proxies is the top item on SECURITY_ROADMAP.md. |
| Backend (optional) | Cloudflare Worker + KV + 1-min cron + dependency-free Web Push (RFC 8291/8292 implemented by hand in `backend/webpush.js`) | Free tier covers everything; iOS app-closed push is impossible from a static site. Deployed manually with `wrangler`, never by CI. |
| Deploy | GitHub Pages via `.github/workflows/static.yml`, staging an **explicit allowlist** of runtime files into `_site/` | The workflow used to upload the whole repo, which once published a real secret. The allowlist + two guards (missing-asset, secret-leak) are the fix. |
| Tests | Zero-framework Node scripts (`backend/test/*.test.mjs`) + headless-Chrome CDP smoke harnesses (`backend/test/verify-*.mjs`) | No test runner to install; harnesses spawn a local HTTP server + real Chrome and mock Yahoo at the proxy layer. |
| Styling | Single `styles.css` (~4,100 lines), CSS custom properties, `:root[data-theme="light"]` overrides, iPhone safe-area handling | Dark theme default; light theme + home-screen icon variant switchable in Settings. |

## 3. Architecture

### 3.1 The module family (script load order matters)

`index.html` loads, in this exact order:

```
React UMD ×2 (unpkg CDN)
pb-core.js   1,376 ln  PURE shared logic — no React/DOM/network. Market sessions,
                       marketOpen, alert evaluation (evaluateAlerts), yahooSymbol,
                       centDivisor, money/FX/cost-basis math, Yahoo quote parsers,
                       buildFetchPlan, parseDecimal, pLimit, priceKey.
                       Imported by BOTH the browser and backend/worker.js.
pb-data.js   1,069 ln  IMPURE client-only network layer. The 6-proxy CORS ladder
                       (fetchViaProxies + in-flight de-dupe + pLimit(8) cap),
                       Yahoo quote/history fetchers, Stooq, Morningstar unit
                       trusts, FRED indicators, quote batchers, ticker→name cache,
                       and the FX providers (fetchFxRates / fetchHistoricalFx +
                       their own direct-first FX_PROXIES ladder).
                       Depends only on pb-core. Worker/sw.js must NOT import it.
pb-store.js    179 ln  The state store: {prices, settings, portfolio} slices +
                       schema-driven configureSettings/configureCollections and
                       useSetting/useCollection/usePricesMap hooks.
pb-content.js  263 ln  Pure static content: RIBBON_CATALOG, INDICATOR_INFO,
                       BUILTIN_MACRO_2026 calendar, RULES prose, SECTOR_* tables,
                       MARKETS/DISPLAY_CURRENCIES/CURRENCY_SYMBOLS.
pb-import.js   874 ln  Pure import engine: Yahoo-suffix→market mapping, fuzzy
                       name/ticker matching, CSV/table→holdings mapper, and the
                       EasyEquities screenshot OCR parsers.
pb-views.js  4,388 ln  Phase 4 view bucket (browser-only classic script): all 11
                       tab views + the Heatmap cluster (HeatmapTreemap/ZoomPanHeatmap
                       + treemap math), the growth-chart cluster, HoldingRow/
                       HoldingsListHead, PortfolioPieChart, useContainerWidth. Reads
                       shared app.js internals at render time via window.PBApp.
pb-modals.js 3,907 ln  Phase 4 modal bucket: all 11 modals (incl. the three rule-#3
                       money modals), the detail + settings subtrees,
                       SectorWeightRows, useSwipeDownToClose, fetchSectorTrend.
                       Registers on window.PBModals; same PBApp bridge.
data.js      1,114 ln  window.PB_DATA — Jan's hand-written reference data:
                       HOLDINGS (theses), NEW_PICKS, HEDGES, RISKS, PILLARS +
                       sector classifiers (findSector/normalizeSector/findInfo).
demo-data.js    54 ln  window.PB_DEMO — deterministic demo portfolio for Preview mode.
app.js       5,030 ln  Everything else, after Phase 4 moved the views + modals out
                       (was ~12.3k): the root App, the shared components still used
                       by both buckets, the hooks (usePortfolio, usePriceFeed,
                       useAlertEngine, useCloudBackup, usePushBackend…), the LS
                       persistence adapter, backup crypto, Hot Topics, and the
                       window.PBApp bridge (38 members, at its verified floor).
                       Contains NO network code since inc-36 — the FX providers
                       moved to pb-data.js.
```

Outside the page:

```
sw.js          303 ln  Service worker (cache v89): precaches the shell
                       (SHELL_ASSETS), network-first for same-origin, SWR for CDN,
                       shows push notifications, AND runs its own background
                       alert-check engine on periodicsync. It now
                       importScripts('./pb-core.js') and delegates yahooSymbol /
                       centDivisor / evaluateAlerts (GAPS.md #2, fixed 2026-07-21);
                       only the inline proxy chain remains its own, deliberately,
                       since pb-data.js is browser-only (rule #6).
backend/worker.js      Cloudflare Worker: /subscribe /sync /test /unsubscribe
                       (push), /backup (zero-knowledge blob store), and a
                       scheduled() cron every minute that fetches quotes for
                       active alerts in open markets, evaluates them with
                       PBCore.evaluateAlerts, and Web-pushes new hits.
backend/webpush.js     Hand-rolled aes128gcm + VAPID (verified against http_ece).
```

### 3.2 Data flow

```
                          ┌────────────────────────────────────────────┐
                          │              app.js  App()                 │
                          │  tab router + providers + ~40 hooks        │
                          │  views: Dashboard/Current/Watchlist/       │
                          │  Heatmap/Picks/Hedges/TFSA/HotTopics/      │
                          │  Rules/Overview + ~12 modals               │
                          └────┬──────────────┬────────────────┬───────┘
             fetch plan (pure) │              │ read/write     │ alerts
                               ▼              ▼                ▼
        PBCore.buildFetchPlan → usePriceFeed  PBStore          useAlertEngine
        fast tier: positions+watchlist+       {prices,         subscribes to store,
        alerts+ribbon, always polled;         settings,        evaluateTriggers →
        picks/hedges/thesis lazy, warmed      portfolio}       PBCore.evaluateAlerts
        on first tab visit                    │    ▲                │
                               │              │    │ per-key        ▼
                               ▼              ▼    │ setters   notification ladder:
                     PBData.fetchQuoteBatch   LS adapter       in-page toast →
                               │              (localStorage    SW showNotification →
                               ▼              pb.* keys)       Periodic BG Sync →
                     fetchViaProxies          │                server push
                     6 public CORS proxies    │ debounced
                     (lastGoodProxy floats;   ▼
                     pLimit(8); de-dupe)      useCloudBackup — AES-GCM encrypt →
                               │                               POST /backup
                               ▼                                    │
                Yahoo v8 chart API (unofficial)                     ▼
                Stooq / FRED / Morningstar /              Cloudflare Worker + KV
                RSS2JSON / Perplexity                     (sees only ciphertext)
```

Key mechanics:

- **Price sweep**: `usePriceFeed` polls on a market-hours-aware cadence
  (`usePolledRefresh`), batches symbols through `fetchQuoteBatch` (batch of 8, with
  a second-pass retry for misses), and merges results into `PBStore.mergePrices`.
  The merge is a shallow `Object.assign` — unchanged symbols keep their object
  reference, which is what makes `React.memo` on leaf rows effective. `App()` itself
  does **not** subscribe to prices; only ~18 leaf consumers do via `usePricesMap()`.
  Result: one sweep ≈ one re-render of subscribers, not ~13 full-tree renders.
- **The day move vs extended hours** — one rule, two numbers. Yahoo's chart
  `meta.regularMarketPrice` is the **last traded** price, so during pre/post it is
  the extended-hours price, not a regular-session one. Treating it as regular is
  what made Oracle read **+11.18%** against Yahoo's **+9.00%** (the after-hours pop
  folded into "Today"). Both numbers are now derived from the **bars**:
  `PBCore.deriveDayMove` resolves *which* regular session `price` belongs to first
  (chart has today's bar / session opened but no bar yet / market shut) and only
  then picks the previous close relative to it, so the pair can never straddle two
  sessions. `parseYahooQuote` uses `meta.regularMarketPrice` only while the market
  is actually in its regular session (or for CRYPTO); otherwise the last daily bar
  — a completed regular close — wins. The daily quote URLs therefore carry **no**
  `includePrePost`: with it, the current day's daily bar absorbs pre/post trades
  and stops being a regular close. Guarded by `backend/test/day-move.test.mjs`.
  **One exception, and it is not optional**: the daily series can lag its own tape —
  the bar for a finished session arrives late, or arrives with a `null` close that
  `buildDailyBars` drops — and then the newest bar is a session too far back.
  `PBCore.regularTickAfterBars` detects that from the response's own internal
  contradiction (`meta.regularMarketTime` is a REGULAR-hours print on a market-local
  day *after* the newest bar) and hands the session back to `meta.regularMarketPrice`,
  with the last bar as its previous close. Without it, `price` **and** `prevClose`
  slid back together, so the quote stayed self-consistent and nothing on screen
  could reveal that every holding's value was short a whole session — which is
  exactly what the SA/TFSA book showed before the JSE open (2026-08-05). The
  regular-hours half of the test is what keeps the Oracle fix intact: a pre/post
  print also lands on a day the series has no bar for, and must never be believed.
  Same guard in `fetchQuoteLight`, so the heatmap can't disagree with the row.
- **Extended-hours quotes**: `PBCore.deriveIntradayExt` turns the 1m intraday chart
  (which *does* keep `includePrePost`) into the pre/post readout. Two modes: a LIVE
  session (`extLive:true`, labels "Pre-market"/"After-hours", may assert marketState
  PRE/POST) and a FINAL reading (`extLive:false`, label "After close") — the post
  session's last trade vs that day's close, shown while the market is fully closed
  (overnight/weekend) so the close→open move never vanishes at the post bell.
  Windows anchor to `meta.tradingPeriods` (the bars' own day) with a day-shifted
  `currentTradingPeriod` fallback via `resolveTradingWindows`. The move is measured
  against the **regular window's own last close**, not `meta.regularMarketPrice` —
  against the latter it compared the session to itself and every readout collapsed
  to ~0.00%. A PRE session's baseline cannot come from a range=1d chart at all
  (today's regular window is still empty), so `fetchQuote` passes yesterday's close
  in as `opts.regularClose`; it also now fetches the intraday chart whenever the
  clock says pre/post, since a fresh pre-market print made the daily quote look
  current and the readout never appeared.
- **Watchlist suggestions**: `PBData.fetchHotStocks` (Yahoo trending + day-gainers/
  most-actives screeners, best-effort per source) feeds a "Hot right now" chip
  cluster, cached in `pb.hotStocks.v1` (BACKUP_SKIP, 10-min TTL). `buildSuggestions`
  excludes everything already held or watched and ranks by market/sector affinity
  from positions+watchlist plus the ticker-search history (`pb.searchHist.v1`,
  durable, written by `recordSearchPick` in `TickerSearch`) — recently searched
  symbols get a decaying boost and surface in the "For you" cluster.
- **Alert evaluation** is the same state machine in the client and the Worker:
  `PBCore.evaluateAlerts` (fires on waiting→hit transitions only, 5-minute cooldown
  re-arm). The client adapter (`evaluateTriggers`, app.js:1265) additionally drops
  quotes older than the cooldown so stale data can't fire. **The service worker has
  a third, hand-ported copy** — the one engine not yet unified (GAPS.md #2).
- **Persistence**: every durable slice is one `pb.<name>.vN` localStorage key,
  written through the `LS` adapter (app.js:37). `LS.set` fires a debounced
  cloud-backup notifier for any key not in `BACKUP_SKIP`. A backup is simply "all
  `pb.*` keys minus SKIP", so new persisted state is captured automatically.
  Settings (11 knobs) and portfolio collections (9 slices, incl. positions/
  transactions/contributions/tfsaDeposits) are declared in schemas
  (`SETTINGS_SCHEMA` app.js:2629, `PORTFOLIO_SCHEMA` app.js:2650) and live in the
  store; a handful of view-local UI states still use `usePersistedState` directly
  (heatmap mode, TFSA targets, watchlist UI state) — that's intentional.
- **Mutators return outcomes, not toasts**: every data mutator returns
  `{ok, code, ...}`; the single copy catalog is `describeOutcome` (app.js:2499);
  `useToastEvents` wraps mutators at the App edge with stable identities.
- **Preview mode** (`pb.previewMode.v1`): `usePortfolio` swaps in `window.PB_DEMO`
  read-only so the app can be demoed without revealing real data.

### 3.3 The backend contract

The app talks to the Worker only if the user pastes a Worker URL into Settings.
One KV record per device (`client:<uuid>`) holds the push subscription + alert list
+ seen map. The cron evaluates only alerts whose market is open and writes KV only
when trigger state changes (free-tier discipline). `/backup` stores
`backup:<sha256(recoveryCode)>` → `{blob:{ct,iv,salt}, updatedAt}`. Trigger
semantics are identical across app/SW/Worker so the three layers never double-fire
(a 90-second foreground heartbeat additionally suppresses server push while the
user is looking at the app).

## 4. How this codebase got its shape (the refactor)

This was a **13,823-line single-file app** five weeks ago. It is mid-way through a
deliberate, phased, test-guarded strangler refactor — do not judge the structure
without knowing the plan:

- **Phase 0** (done): deleted diverged duplicate files, hardened the deploy to an
  allowlist, untracked secrets, fixed README.
- **Phase 1** (done): carved all pure logic into `pb-core.js` with characterization
  tests written *before* moving call sites. This fixed real client/server drift
  (the Worker used to fetch the wrong instrument for `^SPX` and mis-divide JSE ZAR).
- **Phase 2** (done): carved the network layer into `pb-data.js`; added in-flight
  de-dupe + global concurrency cap; split the fetch fan-out into fast/lazy tiers
  (cold-start requests dropped ~3×).
- **Phase 3** (done): added `pb-store.js`; migrated prices, settings, and all 9
  portfolio slices; removed toast from the data layer; stabilized handler
  identities so `React.memo` bites on holdings rows.
- **Phase 4** (done): content extraction into `pb-content.js` / `pb-import.js`
  (increments 1–6), then the view/modal split into `pb-views.js` (all 11 tab views +
  the Heatmap and growth-chart clusters) and `pb-modals.js` (all 11 modals + the
  detail/settings subtrees), reached across increments 7–35. Components read shared
  `app.js` internals through the render-time `window.PBApp` bridge, which is at its
  **verified floor of 38 members** (audited member-by-member in inc-36 — every one is
  genuinely shared across both buckets, consumed by the root `App`, or an impure reader
  coupled to `DATA`). The Vite-vs-no-build decision never had to be forced: the
  dual-mode classic-script pattern carried the whole split with **no build step**.
- **Phase 5** (**CLOSED 2026-07-26, resolved by evidence — Jan's decision**): would have
  put IndexedDB behind a cache interface for churny blobs. **Not built, and should not
  be.** The premise was measured before any code was written and neither justification
  survived: there is no size ceiling (**261 KB today = 5.1%** of budget, 812 KB on a
  5-year model, churny blobs bounded by construction at ~160 KB), and IndexedDB does not
  fix the Safari-eviction risk (ITP evicts IndexedDB too; installed PWAs are exempt; the
  encrypted cloud backup is the real mitigation). The migration was also not cheap —
  `LS` is synchronous and read at module-eval time while IDB is async, so it meant a
  boot-order rewrite plus edits to the backup path (rule #5). Full evidence and the four
  options weighed: `docs/superpowers/specs/2026-07-25-phase-5-indexeddb-storage-design.md`.
  **With Phase 5 closed the refactor is complete**; the next phase is
  [SECURITY_ROADMAP.md](SECURITY_ROADMAP.md).

Every increment follows the same ritual: brainstorm → spec → plan (both committed
under `docs/superpowers/{specs,plans}/`) → implementation with tests → review. The
specs/plans directory is the best written history of *why* each seam exists.

**Test suites double as drift-guards**: several tests grep `app.js`/`worker.js`
source to assert that moved functions are *bound* (`const x = PBCore.x`), not
re-implemented. If you re-inline a `function centDivisor` in app.js, a test fails.

## 5. Key design decisions (and their reasoning)

1. **No build step, consciously.** Every extracted module costs: a `<script>` tag,
   an sw.js precache entry + cache bump, a deploy-allowlist entry, and edits to 16
   test harnesses. That's why extraction produced *five* pb-* files rather than
   fifty small ones. The bundler decision is parked until component-splitting makes
   many global scripts painful.
2. **Dual-mode scripts over ESM.** ESM in the browser would break the
   file:// / classic-script model and the Worker's bundler; the IIFE + dual footer
   pattern runs identically in browser, Worker, and Node tests.
3. **One evaluator for alerts** (pb-core), because the client and server *had
   already drifted* and could fire different alerts. Anything that must behave
   identically foreground/background belongs in pb-core.
4. **Zero-knowledge backup**: the server stores ciphertext keyed by the *hash* of
   the recovery code; the code itself never leaves the device. This is load-bearing
   for trust — don't weaken it casually.
5. **Money semantics** (non-obvious, user-confirmed):
   - Cost basis = trade price **excluding** broker fees (matches EasyEquities'
     "Avg Purchase Price").
   - Overall profit vs. deposits = money put in at the **locked deposit-time rate**
     (actual USD landed), not spot FX.
   - Blended average cost on top-ups = `PBCore.mergeCostBasis`.
6. **Toast at the edge**: the data layer is headless (returns outcome codes);
   UI copy lives in exactly one function. Keep it that way.
7. **Fetch plan fast/lazy split**: static recommendation lists are only polled once
   their tab has been visited ("warmed"), and the active tab's symbols float to the
   front of the sweep. The plan `key` deliberately covers only the fast tier so tab
   switches never trigger refetches.
8. **Jan commits, merges, and pushes — not the agent/CI.** Standing rule since
   2026-06-29. Work is built and verified in the working tree or on a branch; Jan
   reviews and lands it. A push to main *is* a production deploy (Pages).

## 6. Critical paths — what's load-bearing vs. safe

**Handle with maximum care (tests first, always):**
- `pb-core.js` money math (`convertCcy`, `mergeCostBasis`, `contribInDisplay`,
  `resolvePositionUpdates`…) — this is someone's real money. The "money gate" is
  `money-math`, `cost-basis`, `import-matching`, `ee-ocr-parse` tests.
- `pb-core.js` alert evaluation + market sessions — three runtimes depend on it.
- The `LS` adapter, `BACKUP_PREFIX`/`BACKUP_SKIP`, and `gatherBackup`/`applyBackup`
  (app.js:17–107) — cloud backup/restore must stay **byte-compatible**; a format
  break silently corrupts restores.
- The backup crypto block (app.js:109–160) and `backend/webpush.js` — hand-rolled
  crypto, cross-verified by tests; do not "clean up".
- The **wiring quadruple**: `index.html` script order ↔ `sw.js SHELL_ASSETS` +
  `CACHE_NAME` ↔ `.github/workflows/static.yml` allowlist ↔ the 16 `verify-*.mjs`
  harness shells. These four must stay in sync or the live site breaks in
  hard-to-see ways (see GAPS.md #1 for the live example).
- `fetchViaProxies` / proxy ordering in `pb-data.js` — reliability of every price
  on screen depends on it.

**Safe to change casually:**
- `styles.css` (design tokens at the top; theme override block at :root[data-theme]).
- View-component internals in app.js (markup/layout), as long as props and
  store subscriptions are untouched.
- Content *values* in `pb-content.js` and `data.js` (theses, catalogs, calendars) —
  shape changes need the `content.test.mjs` shape tests updated.
- README/docs.

## 7. Things that will trip you up (read before editing)

1. **File encoding landmines**: `app.js` has a BOM and CRLF line endings; `£ € · —`
   are authored as `\uXXXX` escapes. The Edit tool decodes a typed `\uXXXX` into the
   literal glyph — you cannot round-trip these by retyping. All content moves were
   done with Node slice scripts (read file → regex splice → write). A Node
   `.replace()` whose search string spans a newline must use `\r?\n` or it silently
   no-ops.
2. **`node --check` passing means almost nothing** for extractions: the classic
   failure is a moved const still referenced in app.js — syntax-clean, tests green
   (they don't load app.js), app won't mount. Always run the browser smoke
   (`verify-refresh-behavior.mjs`) after touching module boundaries.
3. **Every shipped-asset change needs an sw.js `CACHE_NAME` bump** (currently
   `playbook-shell-v50`), or installed PWAs keep serving the old file offline.
4. **Git history was rewritten** on 2026-06-28 (secret purge via filter-branch);
   any commit SHA from before then that you find in old notes may not resolve.
5. **HoldingRow has no session badge on purpose** — Jan removed it. It was once
   wrongly "fixed" back in; the smoke test now asserts its *absence*.
6. **The live Worker ≠ the repo Worker** until Jan runs `wrangler deploy` (see
   GAPS.md #3). The static site auto-deploys; the Worker never does.
7. **The known-stale test failures are FIXED** (GAPS.md #12, 2026-07-26). `verify-indicators`
   ribbon checks passed a prop the app ignores (`Hero` self-subscribes from `PBStore`) — the
   harness now seeds localStorage before app.js evaluates. The CDP "Execution context
   destroyed" race was **structural**, not flaky: Chrome destroys the `about:blank` context
   when the harness URL commits and harnesses attach in exactly that window. The retry
   `verify-refresh-behavior` always carried is now in all 16 other harnesses, so if you see
   that error again, suspect a NEW cause rather than dismissing it.
   Reliable gates: `verify-refresh-behavior` (THE mount gate), `verify-watchlist`, `verify-settings`.
8. **`BUILTIN_MACRO_2026`** (pb-content.js) is a hand-written one-year calendar that
   must be refreshed annually — it goes quietly stale in 2027.
