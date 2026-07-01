# Design: seven-item Playbook update (2026-07-01)

Covers the 7 items from Jan's goal: consistent "Today's move", hide-value coverage,
preview mode, refresh-peek hold, YTD chart range, stock-card bottom fill, and
scrub-tooltip priority over the OPEN tag.

Decisions confirmed with Jan:
- "Today" counts **only markets that have traded today** (device-local calendar day).
- Hide-value hides **totals only** (per-holding values stay visible).
- Preview portfolio: **~15 trendy names, ≈$25k total**, live real prices.
- The black footer is the **home-indicator strip at the very bottom of the screen**
  when the stock card (detail sheet) is open.

---

## 1. Consistent "Today's move"

**Problem.** Dashboard `todayChange` (app.js ~4704) and the Holdings market summary
(`computeMarketSummary`, app.js ~5080) sum `shares × (price − prevClose)` for every
holding. Before a market opens for the day (US during the SA morning), that
difference is *yesterday's* move for those holdings, so "Today" mixes yesterday's
US session with today's JSE/LSE sessions.

**Fix.** New pure helper in pb-core.js:

```
tradedToday(regularMarketTimeMs, nowMs) -> boolean
```

True iff the quote's last regular-session tick falls on the same calendar day as
`now` in the device's local timezone. Quotes already carry `regularMarketTime` (ms)
from `parseYahooQuote`. Fallback when the tick timestamp is missing: include the
holding iff `marketSession(market).phase === 'open'`. CRYPTO passes naturally
(24/7 ticks).

**Applied to (aggregates only):**
- Dashboard Today pill (todayChange/todayPct loop).
- Holdings tab per-market summary "Today" line (`computeMarketSummary`).

**Explicitly NOT applied to:** per-stock rows (watchlist, holdings rows, stock
card PriceBlock) — a stock's own "day change since its last close" remains standard
per-instrument semantics. The `'today'` sort in CurrentView also stays as-is.

**Behaviour after fix (SAST examples):**
- 09:00 SAST weekday: Today = JSE + LSE moves; US holdings contribute 0.
- 16:30+ SAST: US session open → US moves join.
- Weekend / before JSE opens: nothing traded today → Today pill hidden (todayHasData false).

**Tests.** Node unit tests in `backend/test/` (same harness as existing pb-core
tests): same-day tick, yesterday tick, missing tick + open/closed session, day
boundary just after local midnight.

## 2. Hide-value covers all totals

**Problem.** The eye toggle is Dashboard-local state (`pb.valueHidden.v1`,
app.js ~4725); the donut center Total, Holdings market summaries and TFSA totals
ignore it.

**Fix.** Promote to a PBStore setting `valueHidden` with the **same LS key**
(`pb.valueHidden.v1`) so backup/restore stays byte-compatible. Toggle stays on the
dashboard stat card. Blur with the existing `val-blur` treatment (extend the CSS
selectors, currently scoped to `.total-portfolio-card`):

- Donut center "Total" value — dashboard Allocation donut AND the TFSA tab donut
  (`chart-pie-center-val`). Hover (name + %) stays.
- Holdings tab market summary: Market value, P/L amount, Invested amount, Today
  amount. Percentages stay visible.
- TFSA holdings card: Value, Cost, P/L amounts (percent pill stays).
- Dashboard Growth tracker: Overall Return amount (a portfolio total).
- Portfolio Growth line chart: money axis labels / hover value readouts
  (the line's shape stays).

Out of scope (visible while hidden): per-holding row values, sector-popup values,
deposit logs, contribution-room bars, percentages everywhere.

## 3. Preview mode (Settings)

**Purpose.** Show the app to other people with a realistic portfolio, without
revealing Jan's real holdings/value.

**Mechanism.** New PBStore setting `previewMode` (`pb.previewMode.v1`, default
false) + a new Settings section "Preview" (toggle + explainer). All portfolio
collections are read via `PBStore.useCollection` inside `usePortfolio` (single
read point, post increment-3a/3b). When `previewMode` is on, `usePortfolio`
returns a static demo dataset instead of the store values for: `positions`,
`contributions`, `transactions`, `tfsaDeposits`, plus a demo `watchlist`.
Real localStorage keys are never written; cloud backup never sees demo data.

Alternatives considered: (a) PBStore-level read overlay — unnecessary, one hook
already brokers all reads; (b) separate `pbdemo.*` LS namespace — editable demo,
but risks demo data reaching cloud backup and adds LS-adapter complexity. Rejected.

**Demo dataset** (new `demo-data.js`, loaded like data.js; static, deterministic):
- US: NVDA, MSFT, AAPL, TSLA, AMZN, JPM, LLY, XOM
- LSE: AZN, SHEL · JSE: NPN, SOL · TFSA: STX40 (Satrix Top 40) + STXWDM (Satrix MSCI World) · CRYPTO: BTC, ETH
- Fixed share counts + cost bases sized so total ≈ $25k with a realistic mix of
  green and red P/L at current prices. Live prices drive all figures (the price
  feed derives its symbols from positions, so it follows automatically).
- ~2 years of demo deposits (contributions) so Growth tracker / overall return
  populate; a few TFSA deposits so room bars show.

**Guards.**
- All mutators (add/edit/buy/sell/import/delete positions, log deposits, TFSA
  deposits) short-circuit with a toast: "Preview mode is on — turn it off in
  Settings to edit your real portfolio."
- Alert evaluation pauses while preview is on (no real alerts firing from demo
  browsing; server push untouched).
- Persistent "Preview" badge in the header while on, so it's obvious to Jan and
  to viewers.

## 4. Refresh long-press peek stays while touching

**Root cause.** `.refresh-btn` has no `touch-action`; after the peek opens, a
slight finger drift lets iOS reclaim the gesture for scrolling and fires
`pointercancel` → `endPointer` closes the pill (RefreshControl, app.js ~3610).

**Fix.** `touch-action: none` on `.refresh-btn` (styles.css ~152). Pointer capture
is already taken on pointerdown, so moves keep streaming to the button and no
pointercancel fires. Result: pill stays open while the finger is down, wherever it
drifts; release closes it. The pre-open slop-cancel (SLOP2) stays, so a scroll
that merely starts on the button still scrolls the page. No JS changes expected;
if iOS still cancels in testing, fallback is `preventDefault` on `touchmove` via a
non-passive listener while peeking.

## 5. YTD chart range

- PriceChart `allRanges` (app.js ~9440): insert `{ key: 'ytd', label: 'YTD' }`
  between 6M and 1Y.
- pb-data `fetchHistory` (~752): map `ytd` → `1d` interval (Yahoo accepts
  `range=ytd`).
- `unitTrustRangeStart` and `rangeCutoffMs` (pb-data): add `ytd` = Jan 1 of the
  current year, so unit-trust and indicator charts support it too.
- Chart summary line reads "YTD return" automatically via the range label.
- Check `.chart-ranges` layout with 9 buttons on a narrow screen; adjust spacing
  if it wraps badly.

## 6. Stock card fills to the screen bottom

**Problem.** With the stock detail sheet open, the home-indicator strip at the
very bottom of the screen stays black — the sheet's surface ends above it.

**Fix.** CSS on `.modal-panel` (styles.css ~864): make the sheet paint through the
bottom safe-area inset (anchor to the true viewport bottom, e.g. `100lvh`-based
height or a safe-area-sized background extension). This is an iOS-standalone
viewport quirk that desktop cannot reproduce, so the exact property is settled by
on-device verification with Jan. Content keeps its existing
`calc(18px + var(--safe-bottom))` scroll padding so nothing hides behind the home
indicator. Applies to all bottom sheets (they share `.modal-panel`), which keeps
the fix consistent.

## 7. Price/date popup beats the OPEN tag

While a scrub tooltip (`hover`) or two-finger readout (`sel`) is active, don't
render `.chart-open-tag` (PriceChart, app.js ~9776); it reappears on release.
Also bump `.chart-tooltip` to `z-index: 3` (both currently 2) as belt-and-braces.

---

## Delivery

- Branch: `feature/seven-item-update`, cut from the current
  `refactor/phase-3-increment-3b-money-store` head (depends on the PBStore
  collections migration).
- Commit order: one commit per item where practical (1–7), tests alongside.
- Verification: Node tests for items 1 & 5 logic; on-device (Jan's iPhone)
  confirmation for items 4 and 6; visual checks for 2, 3, 7.
- Security note: demo dataset contains no personal data; no secrets involved;
  nothing pushed without Jan's say-so (per playbook-security-safeguards).
