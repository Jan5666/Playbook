# Seven-Item Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the seven approved items from `docs/superpowers/specs/2026-07-01-seven-item-update-design.md`: timezone-consistent "Today's move", hide-value on all totals, preview mode, refresh-peek hold fix, YTD chart range, stock-card bottom fill, and scrub-tooltip priority over the OPEN tag.

**Architecture:** Playbook is a no-build PWA: `index.html` loads `pb-core.js` (pure shared logic, dual CommonJS/global export), `pb-data.js` (network), `pb-store.js` (settings + collections store), `data.js` (static data), then `app.js` (hand-written `React.createElement`, **no JSX anywhere**). Pure logic goes in pb-core with Node tests under `backend/test/`; UI changes go in app.js + styles.css.

**Tech Stack:** React 18 UMD (no JSX, no build), plain CSS, Node (plain-script tests, no test framework — each test file is `node <file>.mjs` printing ok/FAIL and exiting non-zero on failure).

## Global Constraints

- Branch: `feature/seven-item-update` (already created; spec committed).
- **No JSX** — all UI code is `React.createElement(...)` matching surrounding style.
- **Never rename/change localStorage keys** — `pb.valueHidden.v1` must keep its key when migrated to PBStore; new keys use the `pb.<name>.v1` convention.
- **Never push to remote** — commit locally only; Jan decides when to push (repo deploys to Pages).
- Tests run from `backend/test/`: `node <test-file>.mjs` — plain `ok()` asserts, `process.exit(failures ? 1 : 0)` (copy the style of `market-session.test.mjs`).
- pb-core additions must be added to the `PBCore = {...}` export object (pb-core.js ~592) — it's consumed by both app.js (global) and Node tests (CommonJS).
- Windows shell: use the Bash tool for git commits (PowerShell 5.1 mangles multiline `-m`).
- Line numbers below are approximate — re-grep the anchor snippets before editing.

---

### Task 1: `tradedToday` + `quoteTradedToday` in pb-core (TDD)

**Files:**
- Modify: `pb-core.js` (add two functions after `marketSession`, ~line 113; add both to the `PBCore` export object ~line 592)
- Test: `backend/test/traded-today.test.mjs` (create)

**Interfaces:**
- Consumes: `marketSession(market, now)` (existing, pb-core).
- Produces: `PBCore.tradedToday(tickMs, nowMs) -> boolean` and `PBCore.quoteTradedToday(quote, market, nowMs) -> boolean`. Task 2 binds `quoteTradedToday` in app.js.

- [ ] **Step 1: Write the failing test**

Create `backend/test/traded-today.test.mjs`. Note: `tradedToday` compares **device-local** calendar days, so tests build timestamps with the local-time `Date` constructor (portable across timezones):

```js
// Unit tests for tradedToday/quoteTradedToday in pb-core.js — the "only markets
// that traded today count toward Today's move" kernel (spec 2026-07-01 §1).
//   cd backend/test && node traded-today.test.mjs
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };
const { tradedToday, quoteTradedToday } = PBCore;

ok('exports tradedToday', typeof tradedToday === 'function');
ok('exports quoteTradedToday', typeof quoteTradedToday === 'function');

// All in device-local time: "now" = 2026-07-01 10:00 local.
const now = new Date(2026, 6, 1, 10, 0).getTime();
ok('tick earlier today counts',        tradedToday(new Date(2026, 6, 1, 9, 0).getTime(), now) === true);
ok('tick later today counts',          tradedToday(new Date(2026, 6, 1, 22, 30).getTime(), now) === true);
ok('tick yesterday 23:59 rejected',    tradedToday(new Date(2026, 6, 0, 23, 59).getTime(), now) === false);
ok('tick tomorrow 00:01 rejected',     tradedToday(new Date(2026, 6, 2, 0, 1).getTime(), now) === false);
ok('just after local midnight, yesterday-evening tick rejected',
   tradedToday(new Date(2026, 6, 0, 22, 0).getTime(), new Date(2026, 6, 1, 0, 30).getTime()) === false);
ok('missing tick rejected',            tradedToday(null, now) === false);
ok('NaN tick rejected',                tradedToday(NaN, now) === false);

// quoteTradedToday: prefers the quote's regularMarketTime; falls back to the
// market session clock only when the tick is missing.
ok('quote with today tick counts',
   quoteTradedToday({ regularMarketTime: new Date(2026, 6, 1, 9, 30).getTime() }, 'US', now) === true);
ok('quote with yesterday tick rejected even if session open',
   quoteTradedToday({ regularMarketTime: new Date(2026, 6, 0, 16, 0).getTime() }, 'US', now) === false);
ok('null quote rejected', quoteTradedToday(null, 'US', now) === false);
// Fallback: no tick → market session must be 'open'. 2026-07-01 is a Wednesday.
// 14:00 UTC = 10:00 EDT (US open); 07:00 UTC = 03:00 EDT (US closed).
ok('no tick + US session open counts',
   quoteTradedToday({ price: 1 }, 'US', Date.UTC(2026, 6, 1, 14, 0)) === true);
ok('no tick + US closed rejected',
   quoteTradedToday({ price: 1 }, 'US', Date.UTC(2026, 6, 1, 7, 0)) === false);
// CRYPTO is always open → no-tick crypto quotes always count.
ok('no tick + CRYPTO counts (always open)',
   quoteTradedToday({ price: 1 }, 'CRYPTO', Date.UTC(2026, 6, 4, 3, 0)) === true);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll traded-today tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/test && node traded-today.test.mjs`
Expected: FAIL — `exports tradedToday` fails (undefined), non-zero exit.

- [ ] **Step 3: Implement in pb-core.js**

Insert directly after the closing brace of `marketSession` (~line 113):

```js
  // "Has this instrument actually traded during the user's current local
  // calendar day?" — the kernel behind the dashboard's "Today" aggregates.
  // Before a market opens for the day, its quotes still carry yesterday's
  // session (price = last close, prevClose = the close before), so summing
  // price−prevClose would report YESTERDAY's move as part of today's. Gating
  // on the last regular tick's local day keeps "Today" meaning the user's
  // today across US/JSE/LSE sessions.
  function tradedToday(tickMs, nowMs = Date.now()) {
    if (typeof tickMs !== 'number' || !isFinite(tickMs)) return false;
    const a = new Date(tickMs), b = new Date(nowMs);
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  // Quote-level wrapper: trust the quote's own last-tick timestamp when
  // present; fall back to the session clock (open now ⇒ trading today) for
  // sources that don't carry one (e.g. Stooq).
  function quoteTradedToday(quote, market, nowMs = Date.now()) {
    if (!quote) return false;
    if (typeof quote.regularMarketTime === 'number' && isFinite(quote.regularMarketTime)) {
      return tradedToday(quote.regularMarketTime, nowMs);
    }
    return marketSession(market, nowMs).phase === 'open';
  }
```

Add to the `PBCore` export object (after the `marketSession,` line):

```js
    tradedToday,
    quoteTradedToday,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend/test && node traded-today.test.mjs`
Expected: `All traded-today tests passed`, exit 0.

Also run the neighbours to catch regressions: `node market-session.test.mjs && node markets-core.test.mjs`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add pb-core.js backend/test/traded-today.test.mjs
git commit -m "feat(pb-core): tradedToday/quoteTradedToday day-gating kernel"
```

---

### Task 2: Gate the "Today" aggregates in app.js

**Files:**
- Modify: `app.js` — PBCore bindings block (grep `= PBCore.`, ~line 570–600), Dashboard today-loop (~line 4707), `computeMarketSummary` in CurrentView (~line 5080)

**Interfaces:**
- Consumes: `PBCore.quoteTradedToday(quote, market)` (Task 1).
- Produces: nothing new — behavioral change only.

- [ ] **Step 1: Bind the helper**

Find the existing binding block (grep `const marketSession = PBCore.marketSession` or similar `PBCore.` destructures near the top of app.js) and add alongside, matching its style:

```js
const quoteTradedToday = PBCore.quoteTradedToday;
```

- [ ] **Step 2: Gate the Dashboard today-loop**

At ~app.js:4707, the loop currently reads:

```js
  let todayChange = 0, todayPrevValue = 0, todayHasData = false;
  positions.forEach(p => {
    const q = prices[priceKey(p.market, p.ticker)];
    if (!q || !isFinite(q.price) || typeof q.prevClose !== 'number' || !(q.prevClose > 0)) return;
```

Add the gate after that guard line (and extend the comment above the loop):

```js
  // Today's movement across the whole book, in the display currency. Each
  // holding's day change (price − previous close) is valued in its market's
  // native currency then converted; yesterday's value anchors the percentage.
  // Only markets that have actually TRADED during the user's current local
  // calendar day count — a pre-open US book otherwise reports yesterday's US
  // session as part of today's move (spec 2026-07-01 §1).
  let todayChange = 0, todayPrevValue = 0, todayHasData = false;
  positions.forEach(p => {
    const q = prices[priceKey(p.market, p.ticker)];
    if (!q || !isFinite(q.price) || typeof q.prevClose !== 'number' || !(q.prevClose > 0)) return;
    if (!quoteTradedToday(q, p.market)) return;
```

- [ ] **Step 3: Gate the Holdings market summary**

In `computeMarketSummary` (~app.js:5089) change:

```js
        if (typeof q.prevClose === 'number' && q.prevClose > 0) {
```

to:

```js
        // Day line only counts once this market has traded today (spec §1).
        if (typeof q.prevClose === 'number' && q.prevClose > 0 && quoteTradedToday(q, market)) {
```

(The `else { prevValue += p.shares * q.price; }` branch stays — it keeps the percentage anchor sane.)

Do NOT touch per-stock rows, PriceBlock, or the `'today'` sort — per-instrument "day change since its last close" semantics stay.

- [ ] **Step 4: Sanity check**

Run: `cd backend/test && node traded-today.test.mjs && node market-session.test.mjs`
Expected: pass. Then load the app once (open `index.html` via a local server or the existing dev flow) and confirm the dashboard renders without console errors.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "fix(dashboard): Today aggregates only count markets that traded today"
```

---

### Task 3: `valueHidden` → PBStore setting, blur all totals

**Files:**
- Modify: `app.js` — `SETTINGS_SCHEMA` (~2665), Dashboard (~4725, 4751–4786, growth tracker ~4806–4819), `PortfolioPieChart` (~4253, center ~4498–4500), `renderSummary` in CurrentView (~5105–5136), TFSA holdings card (~9098–9113), `PortfolioLineChart` (~3986–3991, 4003, 4065–4068)
- Modify: `styles.css` — val-blur rules (~783–786)

**Interfaces:**
- Consumes: `PBStore.useSetting(name)` / `PBStore.setSetting(name, value)` (existing).
- Produces: setting `valueHidden` (key `pb.valueHidden.v1` — unchanged key). All components read it directly from the store (no new props).

- [ ] **Step 1: Register the setting**

In `SETTINGS_SCHEMA` (~app.js:2665) add:

```js
  { name: 'valueHidden',     key: 'pb.valueHidden.v1',     default: false },
```

- [ ] **Step 2: Dashboard reads the store**

Replace (~app.js:4725):

```js
  const [valueHidden, setValueHidden] = usePersistedState('pb.valueHidden.v1', false);
```

with:

```js
  const valueHidden = PBStore.useSetting('valueHidden');
```

and change the eye button's `onClick: () => setValueHidden(v => !v)` (~4747) to `onClick: () => PBStore.setSetting('valueHidden', !valueHidden)` — the local setter is dropped entirely.

- [ ] **Step 3: Generalize the blur CSS**

Replace styles.css ~783–786:

```css
.total-portfolio-card .val-blur { filter: blur(10px); user-select: none; -webkit-user-select: none; }
.total-portfolio-card .stat-sub.val-blur,
.total-portfolio-card .dash-today.val-blur { filter: blur(7px); }
.total-portfolio-card .portfolio-summary-row.val-blur { filter: blur(6px); }
```

with app-wide rules (old selectors kept working via the generic base):

```css
/* Hide-value: blur any money figure marked val-blur (totals only — spec §2). */
.val-blur { filter: blur(10px); user-select: none; -webkit-user-select: none; }
.stat-sub.val-blur, .dash-today.val-blur { filter: blur(7px); }
.portfolio-summary-row.val-blur { filter: blur(6px); }
.chart-pie-center-val.val-blur { filter: blur(9px); }
.hsum-value.val-blur { filter: blur(9px); }
.hsum-pl-amt.val-blur, .kv-val.val-blur, .growth-val.val-blur { filter: blur(7px); }
.hsum-blur-inline { filter: blur(6px); }
```

- [ ] **Step 4: Donut center Total**

In `PortfolioPieChart` add near the other store reads (~4254):

```js
  const valueHidden = PBStore.useSetting('valueHidden');
```

and change the center value (~4500):

```js
                React.createElement("div", { className: "chart-pie-center-val" + (valueHidden ? " val-blur" : "") }, fmtTotal(total)))
```

(The TFSA tab reuses `PortfolioPieChart`, so its donut is covered automatically.)

- [ ] **Step 5: Holdings market summary**

In `renderSummary` (CurrentView ~5105), read `const valueHidden = PBStore.useSetting('valueHidden');` at the top of `CurrentView` (once, near `const prices = ...`), then:

- Market value (~5121): `className: "hsum-value mono" + (valueHidden ? " val-blur" : "")`
- P/L amount (~5123): `className: "hsum-pl-amt mono" + (valueHidden ? " val-blur" : "")` (the `%` line below stays clear)
- Invested amount (~5132): wrap only the amount:
```js
          React.createElement("span", null, "Invested ",
            React.createElement("span", { className: valueHidden ? "hsum-blur-inline" : "" }, fmtCcy(s.cost, ccy))),
```
- Today amount (~5135): split so the % stays readable:
```js
          React.createElement("span", { className: "mono" }, "Today ",
            React.createElement("span", { className: valueHidden ? "hsum-blur-inline" : "" }, fmtCcySigned(s.dayChange, ccy)),
            " · ", (dayUp ? '+' : '') + s.dayPct.toFixed(2) + '%')) : null));
```

- [ ] **Step 6: TFSA totals**

In the TFSA holdings card (~9098–9113), read `const valueHidden = PBStore.useSetting('valueHidden');` at the top of the TFSA view component (grep `TFSA holdings` to find it), then add `+ (valueHidden ? " val-blur" : "")` to the three amount classNames: Value `kv-val mono` (~9101), Cost `kv-val mono` (~9104), and the P/L amount span `kv-val mono ${...}` (~9110). The `tfsa-pnl-pct` pill stays clear.

- [ ] **Step 7: Growth tracker Overall Return**

Dashboard ~4814: `className: "growth-val ..."` → append `+ (valueHidden ? " val-blur" : "")`. Leave `growth-pct` clear. Check the second growth-stat in the same grid (grep `growth-stat` below 4819) — any other absolute money amount in the tracker gets the same treatment; percentages stay.

- [ ] **Step 8: Growth line chart money labels**

In `PortfolioLineChart` add `const valueHidden = PBStore.useSetting('valueHidden');` near the top (~3782), then mask (masking beats SVG blur for cross-browser):

```js
  const sym = CURRENCY_SYMBOLS[displayCurrency] || '$';
  const fmtShortRaw = v => {
    if (v >= 1e6) return sym + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return sym + Math.round(v / 1e3).toLocaleString('en-US') + 'k';
    return sym + Math.round(v).toLocaleString('en-US');
  };
  const fmtFullRaw = v => sym + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Hide-value: the growth chart plots the portfolio total, so its money labels
  // mask to dots while hidden (the line's shape stays visible).
  const fmtShort = valueHidden ? (() => '••••') : fmtShortRaw;
  const fmtFull = valueHidden ? (() => '••••••') : fmtFullRaw;
```

(Replace the existing `fmtShort`/`fmtFull` definitions ~3986–3991; the render sites at ~4003/4068 stay untouched.)

- [ ] **Step 9: Verify + commit**

Run: `cd backend/test && node store.test.mjs` — expected pass (schema change is additive).
Manual: toggle the eye on the dashboard → donut Total, Holdings summaries, TFSA totals, growth tracker and chart labels all hide; percentages and per-row values stay.

```bash
git add app.js styles.css
git commit -m "feat(privacy): hide-value now blurs every portfolio total"
```

---

### Task 4: YTD chart range

**Files:**
- Modify: `app.js` — `allRanges` in PriceChart (~9440)
- Modify: `pb-data.js` — `fetchHistory` interval map (~752), `unitTrustRangeStart` (~278), `rangeCutoffMs` (~381)

**Interfaces:**
- Consumes: Yahoo chart API `range=ytd` (native support).
- Produces: range key `'ytd'` usable by every chart surface.

- [ ] **Step 1: Range button**

app.js ~9445, insert between 6M and 1Y:

```js
    { key: '6mo', label: '6M' },
    { key: 'ytd', label: 'YTD' },
    { key: '1y', label: '1Y' },
```

- [ ] **Step 2: Interval mapping**

pb-data.js ~752, change:

```js
    const interval = r === '1d' ? '5m' : (r === '5d' ? '15m' : (r === '1mo' || r === '3mo' || r === '6mo' || r === '1y') ? '1d' : '1wk');
```

to:

```js
    const interval = r === '1d' ? '5m' : (r === '5d' ? '15m' : (r === '1mo' || r === '3mo' || r === '6mo' || r === 'ytd' || r === '1y') ? '1d' : '1wk');
```

- [ ] **Step 3: Unit trusts + indicators**

`unitTrustRangeStart` (~278) — add before `case '1y'`:

```js
      case 'ytd': d.setMonth(0, 1); break;
```

`rangeCutoffMs` (~381) — add before the `default:` line:

```js
      case 'ytd': {
        const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
        return Math.max(day, Date.now() - jan1);   // ≥1 day so early-January still charts
      }
```

- [ ] **Step 4: Verify + commit**

Run: `cd backend/test && node data-providers.test.mjs && node quote-parsers.test.mjs` — expected pass.
Manual: open a stock card → YTD button appears between 6M and 1Y, chart loads with daily bars, summary reads "YTD return". Check `.chart-ranges` doesn't wrap badly with 9 buttons on a ~375px viewport (if it does, reduce `.chart-range-btn` horizontal padding by 1–2px in styles.css).

```bash
git add app.js pb-data.js
git commit -m "feat(charts): YTD range for stocks, unit trusts and indicators"
```

---

### Task 5: Scrub tooltip beats the OPEN tag

**Files:**
- Modify: `app.js` — OPEN tag render (~9776)
- Modify: `styles.css` — `.chart-tooltip` z-index (~1772)

**Interfaces:** none.

- [ ] **Step 1: Hide OPEN while scrubbing**

app.js ~9776, change:

```js
      hasPre && React.createElement("div", {
        className: "chart-open-tag",
```

to:

```js
      // The scrub/date readout owns the top strip while active — the OPEN
      // divider tag yields and returns on release.
      hasPre && !hover && !sel && React.createElement("div", {
        className: "chart-open-tag",
```

(`hover` and `sel` are the PriceChart state values defined at ~9432–9433.)

- [ ] **Step 2: z-index belt-and-braces**

styles.css ~1772 (`.chart-tooltip`): `z-index: 2;` → `z-index: 3;`.

- [ ] **Step 3: Verify + commit**

Manual: 1D chart with pre-market data → OPEN tag visible at rest, disappears while scrubbing, returns on release.

```bash
git add app.js styles.css
git commit -m "fix(charts): scrub tooltip takes priority over the OPEN tag"
```

---

### Task 6: Refresh peek survives finger drift

**Files:**
- Modify: `styles.css` — `.refresh-btn` (~152)

**Interfaces:** none.

- [ ] **Step 1: Own the gesture**

styles.css ~152, change:

```css
.refresh-btn { position: relative; z-index: 2; transition: background 0.2s ease, border-color 0.2s ease; }
```

to:

```css
/* touch-action none: once a press starts on the button we own the gesture, so
   iOS can't reclaim a slight finger drift for scrolling and pointercancel the
   held peek — the pill stays until the finger lifts (spec §4). */
.refresh-btn { position: relative; z-index: 2; touch-action: none; transition: background 0.2s ease, border-color 0.2s ease; }
```

- [ ] **Step 2: Verify + commit**

Run: `cd backend/test && node verify-refresh-peek.mjs` — expected pass (existing harness for this control; if it needs a running dev server, follow the instructions it prints).
On-device (Jan): long-press the refresh button, drift the finger off it → pill must stay until release. If iOS still cancels, fallback (documented in spec §4): add a non-passive `touchmove` listener with `preventDefault()` on the button while `peeking` — implement inside `RefreshControl` (~app.js:3610) via `useEffect` on `peeking`.

```bash
git add styles.css
git commit -m "fix(refresh): keep the long-press peek open while the finger stays down"
```

---

### Task 7: Stock card fills the home-indicator strip

**Files:**
- Modify: `styles.css` — `.modal-panel` (~864)

**Interfaces:** none.

- [ ] **Step 1: Paint below the sheet**

`.modal-panel` has `overflow: hidden`, which would clip a pseudo-element — but box-shadows are not clipped by the element's own overflow. Add a solid offset shadow that paints the sheet's background over any gap between the panel's bottom edge and the true screen bottom (styles.css ~874, inside the `.modal-panel` rule after `overflow: hidden;`):

```css
  /* Paint the sheet's surface over the home-indicator strip: on iOS standalone
     the visual viewport can leave a black safe-area gap below the panel's
     bottom edge; a solid offset shadow fills it without moving any layout
     (box-shadow ignores the element's own overflow clip). Spec §6. */
  box-shadow: 0 60px 0 0 var(--bg);
```

- [ ] **Step 2: Verify + commit**

Desktop: open any sheet + the stock card in a mobile-emulation viewport — no visual change expected (shadow hidden below the viewport edge). Desktop side-panel (`min-width: 640px`) — shadow is offscreen, harmless.
On-device (Jan): open a stock card → the strip behind the home indicator now shows the card surface, not black. If the strip persists, the gap is above the panel's paint area — fall back to `height: calc(100lvh - 48px); max-height: calc(100lvh - 48px);` on `.modal-panel` (keep the 640px media-query override at `height: 100%`).

```bash
git add styles.css
git commit -m "fix(sheets): fill the home-indicator strip with the sheet surface"
```

---

### Task 8: Demo dataset (`demo-data.js`)

**Files:**
- Create: `demo-data.js`
- Modify: `index.html` (script tag after `data.js`, ~line 77)
- Modify: `sw.js` (add `demo-data.js` to the precache asset list — grep `data.js` in sw.js and mirror its entry)

**Interfaces:**
- Produces: `window.PB_DEMO = { positions, watchlist, contributions, transactions, tfsaDeposits }`. Task 9 consumes it in `usePortfolio`.
- Record shapes MUST match the real mutators — **before finalizing, verify field names** against `addPosition` (app.js ~2249), `addContribution`, `addTfsaDeposit`, and `addWatch` (grep each in app.js) and adjust keys if they differ from below.

- [ ] **Step 1: Create `demo-data.js`**

Cost bases are static and chosen so live prices show a realistic green/red mix; JSE/TFSA cost bases are in rand, LSE in pounds (quotes are cent/pence-normalized by `centDivisor` before comparison). IDs are namespaced `demo-*` so they can never collide with real rows.

```js
// Demo portfolio for Preview mode (Settings → Preview). Static, deterministic,
// never written to localStorage — usePortfolio swaps these in read-only while
// pb.previewMode.v1 is on, so the app can be shown without revealing real data.
// Live prices drive all figures; only shares/cost bases/deposits are invented.
(function () {
  const positions = [
    // US — mega-cap tech + spread of sectors (USD)
    { id: 'demo-nvda', ticker: 'NVDA', market: 'US', shares: 6,    costBasis: 128,   name: 'NVIDIA Corporation' },
    { id: 'demo-msft', ticker: 'MSFT', market: 'US', shares: 5,    costBasis: 390,   name: 'Microsoft Corporation' },
    { id: 'demo-aapl', ticker: 'AAPL', market: 'US', shares: 10,   costBasis: 195,   name: 'Apple Inc.' },
    { id: 'demo-tsla', ticker: 'TSLA', market: 'US', shares: 8,    costBasis: 290,   name: 'Tesla, Inc.' },
    { id: 'demo-amzn', ticker: 'AMZN', market: 'US', shares: 6,    costBasis: 185,   name: 'Amazon.com, Inc.' },
    { id: 'demo-jpm',  ticker: 'JPM',  market: 'US', shares: 4,    costBasis: 230,   name: 'JPMorgan Chase & Co.' },
    { id: 'demo-lly',  ticker: 'LLY',  market: 'US', shares: 2,    costBasis: 750,   name: 'Eli Lilly and Company' },
    { id: 'demo-xom',  ticker: 'XOM',  market: 'US', shares: 10,   costBasis: 112,   name: 'Exxon Mobil Corporation' },
    // LSE (GBP)
    { id: 'demo-azn',  ticker: 'AZN',  market: 'LSE', shares: 20,  costBasis: 110,   name: 'AstraZeneca PLC' },
    { id: 'demo-shel', ticker: 'SHEL', market: 'LSE', shares: 40,  costBasis: 26,    name: 'Shell plc' },
    // JSE (ZAR)
    { id: 'demo-npn',  ticker: 'NPN',  market: 'JSE', shares: 4,   costBasis: 3800,  name: 'Naspers Limited' },
    { id: 'demo-sol',  ticker: 'SOL',  market: 'JSE', shares: 60,  costBasis: 140,   name: 'Sasol Limited' },
    // TFSA (JSE ETFs, ZAR)
    { id: 'demo-stx40',  ticker: 'STX40',  market: 'TFSA', shares: 120, costBasis: 85,  name: 'Satrix Top 40 ETF' },
    { id: 'demo-stxwdm', ticker: 'STXWDM', market: 'TFSA', shares: 150, costBasis: 92,  name: 'Satrix MSCI World ETF' },
    // Crypto (USD)
    { id: 'demo-btc', ticker: 'BTC', market: 'CRYPTO', shares: 0.05, costBasis: 65000, name: 'Bitcoin' },
    { id: 'demo-eth', ticker: 'ETH', market: 'CRYPTO', shares: 0.8,  costBasis: 2800,  name: 'Ethereum' }
  ];
  const watchlist = [
    { ticker: 'AMD',  market: 'US',  name: 'Advanced Micro Devices' },
    { ticker: 'PLTR', market: 'US',  name: 'Palantir Technologies' },
    { ticker: 'COIN', market: 'US',  name: 'Coinbase Global' },
    { ticker: 'GOOG', market: 'US',  name: 'Alphabet Inc.' },
    { ticker: 'DSY',  market: 'JSE', name: 'Discovery Limited' }
  ];
  // ~2 years of deposits ≈ $21k committed, so overall profit reads sensibly.
  const contributions = [
    { id: 'demo-c1', amount: 5000,  currency: 'USD', date: '2024-08-15' },
    { id: 'demo-c2', amount: 3000,  currency: 'USD', date: '2024-12-02' },
    { id: 'demo-c3', amount: 45000, currency: 'ZAR', date: '2025-03-10', fxRateAtContrib: 18.4 },
    { id: 'demo-c4', amount: 4000,  currency: 'USD', date: '2025-07-21' },
    { id: 'demo-c5', amount: 30000, currency: 'ZAR', date: '2025-11-05', fxRateAtContrib: 17.9 },
    { id: 'demo-c6', amount: 2500,  currency: 'USD', date: '2026-02-16' },
    { id: 'demo-c7', amount: 2000,  currency: 'USD', date: '2026-05-04' }
  ];
  const tfsaDeposits = [
    { id: 'demo-t1', kind: 'manual', amount: 24000, date: '2025-04-01' },
    { id: 'demo-t2', kind: 'manual', amount: 12000, date: '2026-03-03' }
  ];
  window.PB_DEMO = { positions, watchlist, contributions, transactions: [], tfsaDeposits };
})();
```

**Verification sub-step:** grep the real shapes and reconcile — `addPosition` (position fields incl. optional `purchaseDate`/`costCurrency`/`rateAtCost`), `addContribution` (does it store `fxRateAtContrib`? other required fields like a display-currency snapshot?), `addTfsaDeposit` (field names `kind`/`amount`/`date`), `addWatch` (watchlist items may need `listIds` or `id`). Update the literals above to match exactly what the views read.

- [ ] **Step 2: Load it**

index.html after the `data.js` script (~line 77):

```html
<script src="./demo-data.js"></script>
```

sw.js: add `'./demo-data.js',` to the precache asset list next to `'./data.js'` (grep to find it). Also bump the SW cache version string if the file uses one (grep `CACHE` in sw.js — follow the existing update convention).

- [ ] **Step 3: Verify + commit**

Load the app; console: `window.PB_DEMO.positions.length` → 16; app behavior unchanged (nothing consumes it yet).

```bash
git add demo-data.js index.html sw.js
git commit -m "feat(preview): static demo portfolio dataset"
```

---

### Task 9: Preview mode — setting, substitution, guards, badge, Settings UI

**Files:**
- Modify: `app.js` — `SETTINGS_SCHEMA` (~2665), `usePortfolio` (~2183 + return ~2597), `useAlertEngine` (~1867), header (~3348), `SettingsModal` sections (~12399 + section bodies ~12676)
- Modify: `styles.css` — `.preview-badge` (new, near `.badge` rules — grep `.badge {`)

**Interfaces:**
- Consumes: `window.PB_DEMO` (Task 8), `PBStore.useSetting/setSetting/getSetting` (verify `getSetting` exists in pb-store.js — grep; if absent, read via the settings snapshot API pb-store exposes, or add a thin `getSetting` mirroring `getPrices`).
- Produces: setting `previewMode` (key `pb.previewMode.v1`, default false). While true: usePortfolio returns demo collections read-only; every portfolio mutator toasts instead of writing; foreground alert evaluation pauses; header shows a "Preview" badge.

- [ ] **Step 1: Register the setting**

```js
  { name: 'previewMode',     key: 'pb.previewMode.v1',     default: false },
```

- [ ] **Step 2: Substitute + guard in `usePortfolio`**

At the top of `usePortfolio` (after the collection reads, ~2221):

```js
  // Preview mode (Settings → Preview): swap in the static demo book read-only.
  // Real localStorage is never touched — the store keeps holding the real data,
  // we just don't show it — and every mutator below short-circuits to a toast.
  const previewMode = PBStore.useSetting('previewMode');
  const DEMO = (typeof window !== 'undefined' && window.PB_DEMO) || null;
  const inPreview = !!(previewMode && DEMO);
  const guardPreview = (fn) => (...args) => {
    if (previewMode) {
      toast('Preview mode is on — turn it off in Settings to edit your real portfolio.');
      return;
    }
    return fn(...args);
  };
```

(Note: `guardPreview` closes over `previewMode` from the hook render — that's correct, the hook re-renders when the setting flips.)

Then rework the return (~2597) — demo values on the read side, guarded mutators on the write side; raw setters stay unguarded (cloud restore/import wiring uses them deliberately):

```js
  return {
    positions: inPreview ? DEMO.positions : positions, setPositions,
    watchlist: inPreview ? DEMO.watchlist : watchlist, setWatchlist,
    watchlistGroups: inPreview ? [] : watchlistGroups, setWatchlistGroups,
    alerts, setAlerts,
    contributions: inPreview ? DEMO.contributions : contributions, setContributions,
    transactions: inPreview ? DEMO.transactions : transactions, setTransactions,
    tfsaDeposits: inPreview ? DEMO.tfsaDeposits : tfsaDeposits, setTfsaDeposits,
    sectorCache, setSectorCache,
    sectorWeights, setSectorWeights, setSectorWeightsFor,
    addPosition: guardPreview(addPosition), updatePosition: guardPreview(updatePosition),
    removePosition: guardPreview(removePosition), removePositions: guardPreview(removePositions),
    sellPosition: guardPreview(sellPosition), importPositions: guardPreview(importPositions),
    addContribution: guardPreview(addContribution), removeContribution: guardPreview(removeContribution),
    importContributions: guardPreview(importContributions),
    addTfsaDeposit: guardPreview(addTfsaDeposit), updateTfsaDeposit: guardPreview(updateTfsaDeposit),
    removeTfsaDeposit: guardPreview(removeTfsaDeposit), removeTfsaDeposits: guardPreview(removeTfsaDeposits),
    addWatch: guardPreview(addWatch), removeWatch: guardPreview(removeWatch),
    moveWatch: guardPreview(moveWatch), toggleWatchList: guardPreview(toggleWatchList),
    addWatchGroup: guardPreview(addWatchGroup), renameWatchGroup: guardPreview(renameWatchGroup),
    removeWatchGroup: guardPreview(removeWatchGroup),
    addAlert: guardPreview(addAlert), removeAlert: guardPreview(removeAlert)
  };
```

Also guard the dedup effect (~2230): it calls `setPositions` on mount — add `if (PBStore.getSetting('previewMode')) return;` as its first line **only if** `getSetting` exists; otherwise skip this (the effect writes normalized REAL data, which is safe — it never sees demo rows because it reads `prev` from the store).

- [ ] **Step 3: Pause foreground alert evaluation**

In `useAlertEngine`'s `run` (~1868), first line:

```js
    const run = () => {
      if (PBStore.getSetting && PBStore.getSetting('previewMode')) return; // demo session — don't fire real alerts
```

(Background SW alerts keep running on the real config — deliberate: previewing must not degrade real alerting. Note: `useBackgroundAlerts` receives the real `alerts` array unchanged.)

- [ ] **Step 4: Header badge**

App header (~3348): inside the `brand` div, after the `brand-title` element:

```js
  }, "Playbook"), previewMode && React.createElement("span", { className: "preview-badge" }, "Preview")),
```

`previewMode` in App: `const previewMode = PBStore.useSetting('previewMode');` near App's other store reads. CSS (styles.css, next to the `.badge` rules):

```css
/* Preview-mode pill in the header — loud enough that a demo can't be mistaken
   for the real book. */
.preview-badge {
  margin-left: 8px; padding: 2px 8px; border-radius: 999px;
  font-family: var(--mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--amber); border: 1px solid color-mix(in srgb, var(--amber) 45%, transparent);
  background: color-mix(in srgb, var(--amber) 12%, transparent);
}
```

(Verify `--amber` is defined in `:root` — the status dots use it; if it's named differently, match theirs.)

- [ ] **Step 5: Settings → Preview section**

`sections` array (~12399): add before `data`:

```js
    { key: 'preview', label: 'Preview', icon: 'eye' },
```

Section body — copy the structural idiom of the Appearance section (~12530–12560: `settings-section` wrapper, explainer text, `seg-opt` on/off buttons). Content:

```js
        activeSection === 'preview' && React.createElement("div", { className: "settings-section" },
          React.createElement("div", { className: "text-sm text-dim", style: { marginBottom: 12 } },
            "Show the app with a realistic demo portfolio — trendy stocks across every market and sector, live prices, invented sizes. Your real holdings stay untouched and hidden while it's on; editing is disabled."),
          React.createElement("div", { className: "seg" },
            React.createElement("button", {
              className: "seg-opt" + (!previewMode ? " active" : ""),
              onClick: () => PBStore.setSetting('previewMode', false),
              "aria-pressed": !previewMode
            }, "Off"),
            React.createElement("button", {
              className: "seg-opt" + (previewMode ? " active" : ""),
              onClick: () => PBStore.setSetting('previewMode', true),
              "aria-pressed": previewMode
            }, "On"))),
```

with `const previewMode = PBStore.useSetting('previewMode');` added beside SettingsModal's other store reads (~12344). **Match the real seg/seg-opt markup** from the Appearance section — if it wraps buttons differently, mirror it exactly.

- [ ] **Step 6: Verify + commit**

Run: `cd backend/test && node store.test.mjs && node alerts-core.test.mjs` — expected pass.
Manual sweep with preview ON: dashboard/donut/holdings/TFSA show the demo book with live prices; growth tracker shows demo deposits; watchlist shows demo names; header shows the Preview pill; every add/edit/sell/import/delete/deposit action toasts and changes nothing; Settings → Preview Off restores the real book instantly; `localStorage` keys for positions/contributions unchanged throughout (compare `localStorage.getItem('pb.positions.v2')` — grep the real key name in PORTFOLIO_SCHEMA — before/after).

```bash
git add app.js styles.css
git commit -m "feat(preview): demo-portfolio preview mode with read-only guards"
```

---

### Task 10: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full Node test suite**

Run from `backend/test/`:

```bash
for f in *.test.mjs; do node "$f" || echo "FAILED: $f"; done
```

Expected: every file passes (pre-existing failures, if any, must be noted as pre-existing — check `git stash` / main behavior before blaming this branch).

- [ ] **Step 2: App smoke test**

Serve the repo root (any static server) and click through: dashboard (Today pill, eye toggle), a stock card (YTD, scrub vs OPEN, News at the bottom), Holdings summaries, TFSA tab, Settings (Preview on/off), refresh long-press.

- [ ] **Step 3: On-device checklist for Jan (items 4 & 6)**

Post a checklist message: refresh-peek hold with finger drift; stock-card bottom strip. These two are iOS-only behaviors that desktop cannot prove.

- [ ] **Step 4: Update the spec if reality diverged**

If any fallback fired (peek `touchmove` fallback, `100lvh` fallback) or record shapes differed, update `docs/superpowers/specs/2026-07-01-seven-item-update-design.md` to match what shipped and commit with `docs:`.
