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
for f in backend/test/*.test.mjs; do node "$f" || break; done   # full suite (42)

# MONEY GATE — must be green on ANY change touching money/import code:
#   money-math, cost-basis, import-matching, ee-ocr-parse, fx-providers

# Browser smoke (spawns local Chrome + HTTP server, mocks Yahoo). THE mount gate:
node backend/test/verify-refresh-behavior.mjs
# Reliable smokes: verify-refresh-behavior, verify-watchlist, verify-settings.
#
# IN A CLOUD CONTAINER the gate CAN be run — the last few increments said it could
# not and fell back to node stubs, which is weaker than it needed to be. Three
# things block it, all fixable from outside the repo (2026-08-06):
#   1. CHROME is hardcoded to Jan's Windows path but already honours $CHROME_PATH;
#      Chromium is pre-installed at /opt/pw-browsers/chromium.
#   2. It needs --no-sandbox when the container runs as root.
#   3. The harness loads React from unpkg.com, which egress blocks — but the npm
#      REGISTRY is reachable, so `npm pack react@18.3.1 react-dom@18.3.1`, unpack
#      umd/*.production.min.js, serve them from a /__vendor/ route and rewrite the
#      two <script> tags. Copy the harness to a scratch dir and patch it there;
#      don't edit the 17 committed harnesses for this.
# Done that way, verify-refresh-behavior, verify-watchlist, verify-modals AND
# verify-settings all pass here (2026-08-10). The older note that verify-settings
# "fails at app mounted in this container, pre-existing and environmental" is WRONG
# — it was failing for the SAME unpkg reason as the rest, and the vendor patch fixes
# it. Also drop the Google-Fonts <link> in the patched copy; it is blocked too.
# There is a ready-made patcher recipe: rewrite ROOT to an absolute path, rewrite the
# `from '../../x.js'` imports, add '--no-sandbox' after '--headless=new', swap the two
# unpkg tags for /__vendor/, strip the fonts link, and hook the /__vendor/ route onto
# the handler's first line (every harness spells it `const p = decodeURIComponent(...)`).
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
`playbook-shell-v106`), or installed PWAs serve stale assets offline.
(`LOGO_CACHE` is separate and `node tools/build-logos.mjs` bumps it itself — logo
filenames are stable across rebuilds and `/logos/` is served cache-first, so a
rebuilt pack would otherwise never reach an installed PWA.)

**Re-check this number when merging `main` into a branch that has been open a
while.** Two branches that each bump v103 -> v104 are making the *identical*
change, so git merges them with **no conflict at all** — and the survivor ships
under a cache name that has already been served to installed PWAs, which
therefore never re-fetch the new assets. It compiles, every test passes, and
nothing goes red. It happened on PR #63/#64 (2026-08-10, both v104, resolved to
v105). After any merge from main: `grep -n "playbook-shell-v" sw.js CLAUDE.md`
and make sure it is **ahead of** whatever main is on, not equal to it.

Rebuilding the **logo pack** (`node tools/build-logos.mjs`) also needs `LOGO_CACHE`
bumped in sw.js: `logos/*.png` are served cache-first under stable filenames, so
without it every installed PWA keeps the old marks forever.

Rebuilding the **iOS launch images** (`node tools/build-splash.mjs` -> `brand/splash/*.png`)
means re-wiring the `apple-touch-startup-image` links in index.html to match: that generator
owns the device list, the media queries and the fill colours, and `splash-boot.test.mjs`
fails if index.html, the built files' actual pixel dimensions, or `--pb-bg` in styles.css
drift apart. These are what stop iOS flashing a white screen on launch (Safari ignores the
manifest's `background_color`), and iOS silently ignores any image whose size isn't an exact
device match — so every failure mode here is invisible except as "the flicker is back".
They are deliberately NOT in `SHELL_ASSETS` (see the note there).

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
- **`pb-views.js` is invisible to ripgrep.** It contains 2 NUL bytes (~offsets 21687/21833),
  so `rg`/Grep classify it as binary and **silently skip it** — grepping `quoteTradedToday`
  returns *no hits* in the very file holding both call sites, with no warning. Use `grep -a`
  (or `python`) for pb-views.js, and never conclude "this symbol is unused" from a Grep miss
  alone. ~2,700 lines of view code hide behind this.
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
- **A fundamentals object carries TWO currencies and you must not collapse them.**
  `currency` = what the STATEMENTS are filed in (revenue, EBITDA, cash flow, EPS,
  NAV); `marketCapCurrency` = what the share TRADES in, which is the only thing a
  market cap can be denominated in. They differ for real holdings — Naspers and
  Datatec are rand-listed, dollar-reporting — and Yahoo's timeseries tags *every*
  row (valuation rows included) with the reporting currency, so its tag can never
  be trusted for the cap. Collapsing them printed R570bn as **"$600B"** with no
  conversion. Read both through `PBCore.fundamentalsMoney(f, market, rates)`;
  never do the FX in a view. `fundamentals-parse.test.mjs` renders the real
  `FundamentalsBlock` in a `vm` to pin the labels, not just the numbers.
- **`meta.regularMarketPrice` is the last TRADED price, not the last REGULAR one.**
  During pre/post it is the extended-hours price (and `meta.regularMarketTime` is
  that print's time — `quoteTradedToday` already documents the same trap). Never
  use it as a regular-session price without checking `marketSession(market).phase`
  first; that mistake read Oracle's day as **+11.18%** against Yahoo's **+9.00%**
  and separately collapsed every after-hours % to ~0.00% by measuring the session
  against itself. Day move → `PBCore.deriveDayMove`; ext baseline → the regular
  window's own last bar. `backend/test/day-move.test.mjs` pins both.
- **The last daily bar is NOT unconditionally "the last completed regular close."**
  Yahoo's daily series can lag its own tape: the bar for a finished session arrives
  late, or arrives with a `null` close that `buildDailyBars` drops. Taking `lastBar.p`
  there costs a whole session — and `deriveDayMove` then anchors `prevClose` one
  session further back too, so `price` and the "At close" chip slide together and the
  quote looks perfectly consistent. That is invisible by construction: it is what left
  the entire SA/TFSA book short yesterday's rise before the JSE open (2026-08-05), with
  a green refresh dot. `PBCore.regularTickAfterBars` is the detector — a REGULAR-hours
  `meta.regularMarketTime` on a market-local day *after* the newest bar means meta's
  price is the newer close. The regular-hours half is load-bearing: a US pre/post print
  also post-dates the series and must never be trusted as a close (that is the Oracle
  +11.18% trap). Pre-open is the window where **only** this branch can fire — the
  "no bar yet" branch is gated on `regularSessionStartedToday`, false until the bell.
- **A quote's `sessionDay` is a claim about which session it came from — honour it.**
  `quoteTradedToday` rejects a quote whose `sessionDay` isn't today's market day;
  `null` still passes. Stooq's CSV is end-of-day and carries no `regularMarketTime`,
  so without this its previous-session row fell through to the market clock and got
  counted as *today's* move the instant the JSE opened. `parseStooqCsv` now reads
  column 0 (the row's own date) for exactly this reason.
- **Gating the AGGREGATES is only half a session fix — the ROWS render too.** Every
  session-anchoring fix through 2026-08-05 landed in the quote layer or the two "Today"
  sums, and they were all correct: a quote a session behind carries the right
  `sessionDay` and is correctly dropped from the totals. But `HoldingRow` read
  `q.changePct` with **no gate at all** and decided its "At close" caption from the
  **wall clock** (`marketSession(market).phase !== 'open'`), so at 09:30 SAST a
  session-behind JSE quote printed **+2.94% bare** — yesterday's move, wearing no
  caption, right after the chip said "Updated". (The refresh dot tracks the SWEEP,
  never an individual quote's session; a proxy-cached pre-open response refreshes
  "successfully" forever.) `PBCore.quoteSessionState(q, market)` is now the one
  kernel — `'live' | 'atClose' | 'stale' | 'none'` — and the row, the watchlist card
  and the portfolio heatmap all route through it; `'stale'` **withholds** the number
  (Jan's call). `traded-today.test.mjs` proves it never contradicts
  `quoteTradedToday`, and `day-display.test.mjs` renders the REAL `HoldingRow` in a
  `vm` to pin all three states. Node suites never load view code — that is exactly
  why this survived so long.
- **A `fetch()` promise resolves on HEADERS, so an abort timer cleared at that point
  leaves the BODY read unguarded.** `fetchViaProxies` did precisely that
  (`clearTimeout` in the fetch's `finally`, then a bare `await res.text()`), and a
  proxy that answered 200 then stalled the body hung **forever** — not slowly,
  unboundedly. One stall wedged the `_inflight` entry for that URL (byte-identical
  on every auto-poll, which omits `cacheBust`, so that symbol died for the session),
  then `Promise.allSettled` in `fetchQuoteBatch`, then `loadingRef` in
  `usePriceFeed` — which is what made the refresh button a **silent no-op**. Both
  halves now run inside one `AbortController` via `fetchWithDeadline`, `fxFetch`
  gained a deadline it never had, and `runFetch` has a `SWEEP_WATCHDOG_MS` release
  so the chip can never latch on "Updating…". Pinned in `data-proxy.test.mjs` with a
  mock that honours the abort signal (a real `Response.text()` does).
- **`meta.regularMarketPrice` is never a valid baseline for an extended-hours move** —
  inside a live pre/post session it IS the ext price, so measuring against it compares
  the session to itself and prints **0.00%**. It was `deriveIntradayExt`'s last-resort
  fallback, and it was reached routinely, not rarely: in PRE the regular window has no
  bar yet, and `opts.regularClose` is absent whenever the daily fetch failed. That is
  the "pre-market rates aren't loading" report — they were loading and reading zero.
  The baseline is now resolved AFTER the session is classified, because which close is
  correct depends on which session it is: POST needs **today's** regular close (the
  bars have it), PRE needs the **previous** close (`meta.chartPreviousClose`, from the
  same response, in the bars' own raw units). No baseline → return `null`, never guess.
- **Never put `includePrePost` on an `interval=1d` quote fetch.** It lets the
  current day's *daily* bar absorb pre/post trades, so the bar the day move treats
  as "the regular close" quietly stops being one. The intraday (`1m`) fetch keeps
  the flag — that is where extended hours legitimately comes from.
- **The `width: 1px` visually-hidden recipe does NOT hide a `<table>`'s box.** A table
  can't shrink below its min-content width, so `width: 1px` is a *floor* there, and
  `overflow: hidden` clips its rows while the box itself — 403px measured — still counts
  toward `documentElement.scrollWidth`. `.rot-sr` sat on the Rotation tab's screen-reader
  table exactly like that and drove scrollWidth to **429 at every viewport below it**;
  on an installed iOS PWA (where html/body's `overflow-x: hidden` leaks) that let Jan drag
  the **entire app** sideways, black gutter and all, on that one tab. The class must stay
  on a **div wrapper**. Two corollaries worth keeping: a horizontal-overflow hunt must
  measure `documentElement.scrollWidth`, not "elements past the right edge" (everything
  inside `.nav` / `.heatmap-toggle` always is, and scrolls internally — those are not
  offenders); and `overflow-x: clip` on an ancestor does **not** contain an absolutely
  positioned descendant whose containing block is outside it, which is why `.rot-view`
  now carries `position: relative` alongside the clip. `verify-rotation.mjs` Part C pins
  all of it at 320/375/402/430 — it goes red on pristine HEAD naming `TABLE.rot-sr @429`.
  Chrome clips this properly, so `scrollLeft` reads 0 in the harness either way; the
  symptom is iOS-only but the cause is measurable anywhere.
- **The stock card's bottom-edge bug is STILL OPEN, and the fix below was a no-op on
  the device.** PR #64 shipped (main `1aba422`, Pages deploy green 2026-08-10) and Jan
  reports the black band is *the same size as before*. That is the informative part:
  #64 swapped the sheet's bottom edge from `.modal { inset: 0 }` to an explicit
  `height: max(100vh, 100dvh, 100lvh)` — two structurally different ways of deciding
  where the overlay ends, which measurably move the box in Chrome — and the phone could
  not tell the difference. So the loss is NOT in the `.modal`/`.modal-panel` height
  cascade, and a third variant of that fix is not worth trying. His screenshot also
  rules out a top letterbox (the sheet's rounded top sits at ~48pt, just under the
  status bar; an inset web view would start it at ~107pt) and shows content **sliced
  mid-row** with more below, i.e. a scroll-container clip boundary at every scroll
  position, not end-of-scroll padding. **Settings -> Diagnostics** (added for exactly
  this) prints the device's real numbers — screen vs viewport, all four viewport units,
  a bare `position: fixed; inset: 0` probe, and throwaway clones of a real
  `.modal-panel` and a real `.stock-detail-panel` pressed against its ceiling.
  `verify-settings.mjs` asserts every "short by" row reads **0px** in Chrome, which is
  what makes a non-zero row on the phone mean something. Get those numbers before
  touching this CSS again.
- **A sheet's bottom edge had THREE declarations claiming to own it, and the shortest
  silently won.** `.modal { inset: 0 }`, `align-items: flex-end` and the panel's
  `calc(100dvh - 48px)` all meant "the bottom"; when they disagreed on iOS standalone
  the sheet stopped a home-indicator inset (~34pt ≈ 0.5cm) short of the glass, and the
  `box-shadow: 0 60px 0 0 var(--bg)` band painted that strip in the sheet's own
  near-black — right colour, **zero content**, which is exactly what "the bottom of the
  screen is blacked out" looked like. `.modal` now carries a definite height (grown to
  `max(100vh, 100dvh, 100lvh)` in standalone **only** — in a browser tab `100lvh` is the
  toolbar-hidden height and would shove the sheet under the toolbar), and the panel sizes
  off `calc(100% - 48px)` so there is one source of truth. The box-shadow stays as paint
  insurance, not as the fix. **This is invisible in Chrome** — `env(safe-area-inset-*)`
  is 0 there and the gap never reproduced; simulate the inset with
  `:root, :root[data-theme="dark"], :root[data-theme="light"] { --safe-bottom: 34px !important }`
  (a bare `:root` override LOSES to styles.css:1's `:root, :root[data-theme="dark"]` arm
  once app.js sets `data-theme`).
- **The stock card is the one sheet that spends its safe-area inset on content**
  (Jan's call, 2026-08-10). `.modal-panel.stock-detail-panel > .modal-body` drops the
  `var(--safe-bottom)` reservation so the chart/fundamentals/news reach the physical
  bottom edge; every other sheet keeps it because its pinned action row has to stay
  clear of the home indicator. `verify-modals.mjs` §6 asserts **both sides** of that
  asymmetry — dropping the inset app-wide would pass half the section and fail the other.
- **`verify-modals.mjs`'s stock-detail section had never once opened the card.** Its row
  selector was a `[class*="holding"]` union, which matches the `.holdings-summary`
  container first; the section printed `(no stock detail)` and, having no assertion behind
  it, read as green for its whole life. Fixed to `.holding-row`. A `console.log`-only
  "check" in a browser harness is not a check.

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

## Fundamentals currency audit (2026-08-04)

Jan reported non-US market caps being wildly wrong (Naspers **$600B**, Datatec **$20B** — both
were the *rand* figure wearing a dollar sign). Root cause: a fundamentals object mixes a
**statement** currency and a **listing** currency, and the code carried **one** field for both.
`parseFundamentalsTimeseries` set it from the first `currencyCode` it met walking Yahoo's payload —
a statement row — so for the many JSE names that report in USD the card took its `nativeCode ===
'USD'` branch and skipped conversion entirely. It was never market-specific: a rand-*reporting*
JSE name (Shoprite) converted fine, and a US-listed EUR reporter was silently ~8% high the other
way. Fixed by splitting the field (`currency` + `marketCapCurrency`) and moving the valuation into
`PBCore.fundamentalsMoney` — see the gotcha above. Cached objects heal on their own: the
fundamentals TTL cache is `useState`-only, never persisted, and the helper falls back to the
market's currency.

The same sweep fixed, in the same pipeline: statement figures (revenue/EBITDA/FCF/EPS/NAV) labelled
with the **market's** symbol instead of the reporting one; quoteSummary's 52-week range and 50/200-day
averages left un-divided (100x on LSE/JSE); margins pairing a **TTM** numerator with a **fiscal-year**
denominator; `v(a) || v(b)` chains discarding a legitimate `0`; a NAV premium computed across two
currencies; analyst targets compared against the price without checking the target's currency (the S&P
Global pool quotes some JSE names in USD → a ~-95% "upside"); a P/E captioned "Q ended" off
`quarterlyMarketCap`'s **valuation** date; and `push()`'s sub-line silently dropped by the stats grid.
Dividend yield — which no keyless source carries any more — is now derived from the chart API's own
`events=div` payments (`PBCore.parseDividendEvents`, TTM sum ÷ price, so the pence/cents divisor
cancels). `CACHE_NAME` -> **v101**.

**The browser gate could not run for this change**: this container's egress policy 403s both
`query1.finance.yahoo.com` and `unpkg.com`, and every `verify-*.mjs` harness loads React from unpkg.
Substitute evidence: all 41 node suites green, `fundamentals-parse.test.mjs` grown 35 -> 103
assertions (including a `vm` render of the real `FundamentalsBlock`), plus an ad-hoc evaluation of all
10 shipped scripts in index.html order under browser stubs — 11 modals, 17 views, **38** bridge
members, i.e. the `window.PBApp` floor is unchanged.
