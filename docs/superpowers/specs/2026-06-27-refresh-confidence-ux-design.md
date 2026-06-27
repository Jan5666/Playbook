# Refresh-confidence UX + per-symbol market-session state

**Date:** 2026-06-27
**Branch base:** `main` (head `abeaf46`, post Phase-2 inc 3 — fan-out split is live)
**Scope this round:** Close **root cause B** of the "prices feel slow / refresh feels broken / can't tell if data is fresh" complaint — the *feedback* gap (root cause A, fan-out, was fixed in Phase 2 inc 3). Make freshness, refresh actions, and per-symbol market-session state legible so a quiet feed reads as "market closed", not "broken".

Companion to the Phase 2 inc 3 fan-out design (`docs/superpowers/specs/2026-06-27-phase-2-increment-3-fanout-design.md`, "Diagnosis captured / deferred"), which fixed the load half and explicitly deferred this feedback half to "a focused refresh-confidence UX increment".

## Why now (the trigger)

The user reported they "can't see premarket stock price data anymore." A systematic-debugging pass (2026-06-27) found **no regression**: it was simply the weekend (Sat 20:42 UTC, ~21 h after Friday's post-market close), so `deriveIntradayExt` correctly returns `null` and no extended-hours data exists to show. The live Yahoo probe confirmed the API still serves `currentTradingPeriod.pre/post`; the fetch+parse path is byte-equivalent to its pre-refactor form. The real defect is that **the app never tells the user it's closed** — absence of premarket data is indistinguishable from breakage. That is precisely root cause B, so the premarket confusion folds into this increment as a per-symbol market-session indicator.

(One incidental API drift noted, not fixed here: Yahoo now omits `meta.marketState` from the chart endpoint, so `quote.marketState` is usually `'UNKNOWN'`. Nothing in the app depends on its value — verified by grep — and the session badge derives phase from the clock + `extKind`, not `marketState`. Left as-is.)

## Goal

Three felt symptoms, three fixes, all localized to the header status chip + the shared price-block renderer, driven by signals the price feed already exposes (`loading`, `lastUpdate`, `failStreak`) plus a small pending flag:

1. **Freshness is legible.** A live "Updated Ns ago" that ticks replaces the static `HH:MM`, so within a minute of a refresh the user sees movement.
2. **Refresh actions are acknowledged.** Explicit `Updating…` / `Updated ✓` / `Couldn't refresh — tap to retry`; a mid-sweep press is acknowledged instantly instead of silently queued; success is confirmed even when the numbers didn't change.
3. **Market state is explicit, per symbol.** Each holding/watchlist/detail price shows `Pre-market` / `Open` / `After-hours` / `Closed · opens HH:MM` so a quiet weekend feed reads correctly.

**Non-goals (deferred):** a Worker-side shared quote cache to retire the public proxies (P1/Phase 5); a holiday calendar (see Constraints); per-row "this individual price is stale" badges (the global chip + session state cover the felt need); any move of the FX fetchers out of `app.js`.

## Constraints (inherited)

- **No build step.** Changes live in `app.js` (React) + a pure helper in `pb-core.js`. No new `<script>` file ⇒ no `index.html`/`static.yml` allowlist change; bump `sw.js` cache version (v34 → v35) because `app.js`/`pb-core.js` change.
- **`pb-core.js` = pure, side-effect-free, worker-shared.** The new session kernel is pure (clock + tables, no React/DOM/network) → it goes in `pb-core.js` and is unit-tested in node. The React wiring (chip state, ticking hook, badge component) stays in `app.js`.
- **Bind pattern:** never reintroduce a moved/added pure fn as a local `function`; bind with `const marketSession = PBCore.marketSession;`.
- **No holiday calendar.** `marketSession` is clock-only, exactly like the existing `marketOpen` — a US market holiday will read `Open`/`Closed` by weekday rule, not by the exchange calendar. This is an accepted, pre-existing limitation; out of scope to fix here.
- **No worker/SW logic change**, no `wrangler deploy`. Only the `sw.js` cache-version bump.
- **Sequencing rule:** pin behavior with a test before changing it. The pure kernel gets node unit tests; the chip/badge end-to-end behavior is pinned by extending `backend/test/verify-refresh-behavior.mjs` (the headless-browser smoke — node suites never load `app.js` in a browser).

## Section 1 — Behavior contract

### 1a. Live "Updated Ns ago" (status chip)
- The chip text shows elapsed time since `lastUpdate`, ticking: `just now` (<5 s) → `Ns ago` → `Nm ago` → `Nh ago`. Cadence is a single shared `useNow()` interval at ~5 s while under a minute, coarsening above (it never needs sub-5 s precision). One timer for the whole app; no per-row timers.
- The chip's `title` (hover) keeps the absolute timestamp (`Last refresh 14:32:07`).

### 1b. Refresh action states (status chip)
The chip is the single refresh status **and** control surface. Display resolves in priority order:
1. **Updating…** — `loading` is true (a sweep is in flight), or a press was just acknowledged (1c). Dot = `loading`.
2. **Couldn't refresh — tap to retry** — the most recent attempt failed: *manual* failures show immediately; *auto-poll* failures show only after `failStreak ≥ 2` (preserves today's noise threshold so a single transient blip during background polling doesn't cry wolf). Dot = `stale`.
3. **Updated ✓** — brief (~2 s) flash after a sweep completes successfully, shown **even if no price changed** (keyed off sweep completion, not a price diff), then settles to 1a. Dot = `live`.
4. **Updated Ns ago** (1a) — steady state. Dot = `live`.
5. **Loading…** — cold start, no `lastUpdate` yet. Dot = `loading`.

### 1c. Instant press acknowledgement
- Tapping the chip calls `refreshPricesNow()`. If a sweep is already in flight, the existing `pendingForceRef` queues a follow-up (unchanged) — but the chip flips to **Updating…** *immediately* via a `pendingAck` flag, instead of looking ignored until the slow sweep ends. The flag clears when the next sweep completes (success → Updated ✓; failure → Couldn't refresh).
- The chip is keyboard/tap accessible (`role="button"`, `tabIndex`, Enter/Space) since it is now interactive.

### 1d. Per-symbol session badge
For each rendered quote: `phase = quote.extKind` (`'pre'`/`'post'`, when Yahoo reports a live ext session with a move) **else** `marketSession(market, now).phase`. Render a small dot + label:
- `pre` → **Pre-market**, `post` → **After-hours** (these already render as the price-block ext chip when `hasExt`; the badge is the label for the `!hasExt` case and for rows that don't show the ext price).
- `open` → **Open**
- `closed` → **Closed · opens HH:MM** (market-local, e.g. `09:00 SAST` / `09:30 ET`), where the time comes from `marketSession(...).nextOpenMs`.
- The badge appears wherever the shared price-block currently gates ext display on `hasExt` (app.js:3585-3665) so a closed/quiet symbol shows *something* instead of nothing; the existing ext-price chip continues to render on top when `hasExt`. CRYPTO renders no badge (always open, no session concept worth surfacing).

## Section 2 — Architecture

**Pure kernel — `pb-core.js` (`marketSession`):**
- Signature: `marketSession(market, now = Date.now()) → { phase, nextOpenMs }`, `phase ∈ 'pre' | 'open' | 'post' | 'closed'`.
- Implementation mirrors `marketOpen`: read the market-local weekday + minutes-of-day via `Intl.DateTimeFormat` in `SESSIONS[market].tz`. Classify against per-market boundaries. `SESSIONS` is extended with an optional regular window so pre/post can be distinguished from regular:
  - US gains `regOpen: 9*60+30, regClose: 16*60` (existing `open:4*60`/`close:20*60` already bound the pre/post envelope). `pre = [open, regOpen)`, `post = [regClose, close)`.
  - Markets with no real extended hours (JSE/LSE/ASX/FRA/PAR/AMS/TFSA) omit `regOpen/regClose` ⇒ the whole `[open, close]` window is `open`, and pre/post never occur. Behavior-preserving for `marketOpen` (it ignores the new fields).
  - CRYPTO → always `open`.
- Weekends → `closed` (same Sat/Sun rule as `marketOpen`). `nextOpenMs` = the next `open` boundary that is a weekday, computed in market-local time and returned as epoch ms (UTC). Returns `null` for CRYPTO.
- Pure, deterministic given `now`; no dependency on any quote. The live `quote.extKind` refinement (1d) happens in `app.js` at the badge, not in the kernel — the kernel is the clock truth, `extKind` is the upstream confirmation that an ext session is actually trading.
- Added to the `PBCore` export object next to `marketOpen`.

**React wiring — `app.js`:**
- `const marketSession = PBCore.marketSession;` bound next to `marketOpen`/`anyMarketOpen`.
- `useNow(intervalMs)` — a tiny hook returning a state value that updates on an interval, so the chip re-renders to advance "Ns ago" without touching the feed. Lives in `App` (or module scope) and is the only new timer.
- A `fmtAgo(fromMs, nowMs)` pure-ish formatter for the relative string (can live in `app.js` or `pb-core`; default `app.js` since it's presentational — decide in the plan).
- Status-chip JSX (app.js:3280-3290) reworked to compute the 1b state from `loading`/`lastUpdate`/`failStreak`/`pendingAck`/`lastSweepWasManual`, render the ticking text, and become an interactive retry control calling `refreshPricesNow`.
- `pendingAck` state + a flag distinguishing manual vs auto refresh. `refreshPricesNow` already exists; the chip's `onClick` sets `pendingAck` then calls it. The success-flash (`Updated ✓`) is a short-lived state set when `loading` transitions true→false without a new failure.
- `SessionBadge({ market, quote })` presentational component, rendered inside the shared price-block (app.js:3585-3665) and the watchlist variant (app.js:7422-7479).

**Data flow:** the feed is unchanged — no new fetch, no change to `order`/`key`/cadence. This increment is purely *presentational state* derived from already-exposed signals + the clock. The only new runtime cost is one low-frequency interval (`useNow`) and a pure `marketSession` call per rendered quote (cheap; memoizable per market+minute if profiling ever shows it matters — not pre-optimized).

## Section 3 — Edge cases to preserve

- **Cold start:** no `lastUpdate` → chip shows `Loading…` (state 5), not "Updated NaN ago". `marketSession` is never called before quotes exist; badges render once a quote is present.
- **`extKind` vs clock disagreement:** `deriveIntradayExt` returns `null` when the ext move is < 0.05 % (no meaningful move yet) even during a real pre session. In that window the badge falls back to the clock kernel, which correctly says `Pre-market`. So the badge is *more* robust than `extKind` alone — it never silently shows `Open` during pre-market just because the first ext tick equals the close.
- **DST:** handled by `Intl` time zones (same mechanism `marketOpen` already relies on); `nextOpenMs` is computed from market-local wall-clock boundaries, so it stays correct across DST shifts.
- **`Updated ✓` vs `Couldn't refresh`:** a sweep that completes but returns some nulls is still a "success" for the chip (the feed merged what it got); only an actual fetch failure (the feed's existing failure signal) drives `Couldn't refresh`. Manual-fail-immediate keys off the press being the most recent trigger.
- **Non-US closed time formatting:** `Closed · opens HH:MM` uses the market's own tz abbreviation; JSE shows SAST, LSE shows GMT/BST, etc. Derived from `SESSIONS[market].tz`, no hardcoding.
- **Splash gate / poll cadence:** untouched — this increment adds no symbols and changes no `order`/`key`, so `anyMarketOpen` and the splash gate behave exactly as after inc 3.

## Section 4 — Testing

- **Node unit tests** for `marketSession` (`backend/test/market-session.test.mjs`, new), with an injected `now`:
  - US: a weekday timestamp in each window → `pre` / `open` / `post` / `closed`; the boundary minutes (09:30, 16:00, 20:00, 04:00 ET) classify on the correct side.
  - Weekend (Sat/Sun) for US and JSE → `closed`, and `nextOpenMs` lands on the next weekday's open in market-local time (verify by formatting it back through `Intl` in the market tz).
  - JSE (no extended hours) → only `open`/`closed`, never `pre`/`post`.
  - CRYPTO → always `open`, `nextOpenMs === null`.
  - Anti-drift guard: `app.js` binds `marketSession` from `PBCore` and defines no local `function marketSession(`; `SESSIONS` US still satisfies `marketOpen` (the new `regOpen/regClose` don't change `marketOpen` results — pin a US 11:00 ET = open, 21:00 ET = closed case).
- **Headless-browser smoke** — extend `backend/test/verify-refresh-behavior.mjs`:
  - The status chip renders a relative-time string (matches `/ago|just now|Loading/`), not a bare `HH:MM`.
  - Clicking the chip flips it to `Updating…` within a tick (instant ack), before the sweep resolves.
  - After a sweep completes, the chip shows `Updated ✓` then a relative time.
  - At least one rendered price shows a session badge label (`Closed`/`Open`/`Pre-market`/`After-hours`) — on a weekend run that is `Closed`, proving the previously-blank case now communicates state.
- Full existing node suite stays green; `node --check pb-core.js app.js`.

## Section 5 — Mechanical / deploy

- `pb-core.js`: add `marketSession` (+ export), extend `SESSIONS.US` with `regOpen`/`regClose`.
- `app.js`: bind `marketSession`; add `useNow` + `fmtAgo`; rework the status chip (state machine + interactivity + ticking); add `pendingAck`/manual-flag/success-flash state; add `SessionBadge` and render it in the shared price-block + watchlist variant.
- `sw.js`: cache version v34 → v35.
- No new file ⇒ no `index.html`/`static.yml` allowlist change. No worker/wrangler impact. Static site auto-redeploys on push to `main`.

## Section 6 — Increment breakdown (for the plan)

- **Step A — pure kernel.** RED-first `market-session.test.mjs` → implement `marketSession` + `SESSIONS` regular-window fields in `pb-core.js` → green → commit.
- **Step B — chip rework.** `useNow`/`fmtAgo`; chip ticking text + 1b state machine + 1c instant-ack interactivity; bind `marketSession`. Extend the browser smoke (chip rows). Green → commit.
- **Step C — session badge.** `SessionBadge` + render in price-block (app.js:3585-3665) and watchlist (7422-7479); browser-smoke badge row. Bump `sw` cache. Green → commit.
- **Step D — verify + memories.** Browser smoke confirms ticking/ack/flash/badge; update `playbook-postponed-tasks` (root cause B done; Worker quote-cache still deferred) and `playbook-refactor-priorities` (note this UX increment landed atop Phase 2 inc 3).

## Open items / risks

- `fmtAgo` placement (pb-core vs app.js) — presentational, default app.js; trivial, decide in plan.
- Confirm the shared price-block renderer (app.js:3585-3665) and the watchlist variant (7422-7479) are the only two places ext/price renders, so the badge has full coverage; grep `extLabel`/`ext-hours`/`hasExt` during the plan to be sure no third site shows a quote without a badge.
- `marketSession` per-render cost is negligible, but if the holdings list is very long, memoize per `(market, minute)` — not pre-optimized; only if profiling shows it.
