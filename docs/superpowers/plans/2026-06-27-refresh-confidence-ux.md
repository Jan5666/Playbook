# Refresh-Confidence UX + Per-Symbol Market-Session State — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make price freshness, refresh actions, and per-symbol market-session state legible — a live "Updated Ns ago" chip with Updating…/Updated ✓/Couldn't-refresh states and instant press-ack, plus a per-symbol Pre-market/Open/After-hours/Closed badge — so a quiet feed reads as "market closed", not "broken".

**Architecture:** Three pure, node-tested helpers go in `pb-core.js` — `marketSession` (clock-derived session phase), `fmtAgo` (relative time), and `refreshChipState` (the chip state resolver). `app.js` binds them, adds one shared `useNow()` ticking hook + a little ack/flash state, reworks the status chip into a ticking interactive retry control, and renders a `SessionBadge` wherever the shared `PriceBlock` currently gates ext display on `hasExt`. No new fetches, no cadence change — this is presentational state derived from signals the feed already exposes (`loading`, `lastUpdate`, `failStreak`).

**Tech Stack:** Vanilla ES (no build step, no JSX), React 18 UMD, dual-mode `pb-core.js` (`globalThis.PBCore` + CommonJS), Node `.mjs` test files run individually with `node X.test.mjs`, a headless-Chrome smoke harness (`backend/test/verify-refresh-behavior.mjs`), `styles.css`, `sw.js` precache.

## Global Constraints

- **No build step.** Only these files are touched: `pb-core.js`, `app.js`, `styles.css`, `sw.js`, and two `backend/test/*.mjs` files. No new `<script>`/asset file ⇒ no `index.html`/`static.yml` allowlist change (`styles.css` is already an allowlisted, precached runtime asset).
- **`pb-core.js` = pure, side-effect-free, worker-shared.** `marketSession`/`fmtAgo`/`refreshChipState` take all inputs as arguments; no React/DOM/network. They use only `Date`/`Intl`/`isFinite` (run unchanged in browser, Worker, Node).
- **Bind pattern in `app.js`:** never reintroduce a moved/added pure fn as a local `function`; bind with `const marketSession = PBCore.marketSession;` etc.
- **Dual-mode footer already present in `pb-core.js`** — add the three new fns to the existing `const PBCore = { ... }` object (lines 496-520).
- **No holiday calendar.** `marketSession` is clock-only, exactly like the existing `marketOpen` (a US market holiday reads Open/Closed by weekday). Accepted, pre-existing limitation; out of scope.
- **TDD, RED first.** Write the failing test, watch it fail for the right reason, then implement. Commit after each green task.
- **Test runner:** no npm script. Run `cd backend/test && node <file>.test.mjs`. House helper `const ok = (name, cond, extra) => {...}` + `process.exit(failures ? 1 : 0)`. Import with `import PBCore from '../../pb-core.js'`.
- **Anti-drift guard:** the test reads `app.js` source and asserts it binds each new fn from `PBCore` and carries no local `function marketSession(`/`function fmtAgo(`/`function refreshChipState(`.
- **Line endings:** `app.js`/`pb-core.js`/`styles.css` are CRLF; the Edit tool normalizes CRLF on match, so `\n` old-strings match. New test files are written with `\n`.
- **No worker/SW logic change, no `wrangler deploy`.** Only a `sw.js` cache-version bump (v34 → v35) so the changed `app.js`/`pb-core.js`/`styles.css` are re-fetched.

## File Structure

- `pb-core.js` — add `marketSession`, `fmtAgo`, `refreshChipState` (+ exports); extend `SESSIONS.US` with `regOpen`/`regClose`. (Tasks 1-2)
- `backend/test/market-session.test.mjs` — new node unit tests for `marketSession`. (Task 1; anti-drift rows appended in Task 3)
- `backend/test/refresh-chip.test.mjs` — new node unit tests for `fmtAgo` + `refreshChipState`. (Task 2; anti-drift rows appended in Task 3)
- `app.js` — bind the three fns; add `useNow`; add chip ack/flash state + `onChipRefresh`; rework the status-chip JSX + route the existing refresh icon-button through `onChipRefresh`; add `SessionBadge` + render it in `PriceBlock` and the watchlist card. (Tasks 3-4)
- `styles.css` — `.session-badge`/`.session-dot`/phase colors. (Task 4)
- `sw.js` — cache version v34 → v35. (Task 4)
- `backend/test/verify-refresh-behavior.mjs` — chip-behavior assertions (Task 3) + session-badge assertion (Task 4).

---

## Task 1: Add the pure `marketSession` kernel + regular-session boundaries to `pb-core.js`

The per-symbol session phase (pre/open/post/closed) and the "opens HH:MM" label are pure clock logic — they belong in `pb-core.js`, unit-tested in isolation.

**Files:**
- Modify: `pb-core.js` — extend `SESSIONS.US` (line 25); add `localWeekdayMins`, `fmtOpenLabel`, `marketSession` after `anyMarketOpen` (after line 62); add `marketSession` to the `PBCore` object (near line 500).
- Test: `backend/test/market-session.test.mjs` (new)

**Interfaces:**
- Produces: `PBCore.marketSession(market, now = Date.now()) => { phase, nextOpen }`
  - `phase`: `'pre' | 'open' | 'post' | 'closed'`.
  - `nextOpen`: `string | null` — a formatted regular-open label like `"09:30 EDT"` when `phase === 'closed'`, else `null`. CRYPTO → `{ phase: 'open', nextOpen: null }` always.
  - Markets with no `regOpen`/`regClose` in `SESSIONS` never return `'pre'`/`'post'` (their whole `[open, close]` window is `'open'`).

- [ ] **Step 1: Write the failing test** — create `backend/test/market-session.test.mjs`:

```js
// Unit tests for the pure marketSession kernel in pb-core.js (refresh-confidence UX).
//   cd backend/test && node market-session.test.mjs
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };
const { marketSession, marketOpen } = PBCore;
// 2026-06-30 is a Tuesday; late June ⇒ US is on EDT (UTC−4). JSE is UTC+2, no DST.
const US = (...utc) => marketSession('US', Date.UTC(...utc)).phase;
const JSE = (...utc) => marketSession('JSE', Date.UTC(...utc)).phase;

ok('exports marketSession', typeof marketSession === 'function');

// US weekday windows (EDT = UTC−4): pre 04:00–09:30, regular 09:30–16:00, post 16:00–20:00.
ok('US pre-market (08:00 EDT)',        US(2026, 5, 30, 12, 0)  === 'pre');
ok('US open at 09:30 boundary',        US(2026, 5, 30, 13, 30) === 'open');
ok('US regular hours (10:00 EDT)',     US(2026, 5, 30, 14, 0)  === 'open');
ok('US post at 16:00 boundary',        US(2026, 5, 30, 20, 0)  === 'post');
ok('US after-hours (19:00 EDT)',       US(2026, 5, 30, 23, 0)  === 'post');
ok('US closed pre-dawn (03:00 EDT)',   US(2026, 5, 30, 7, 0)   === 'closed');
ok('US closed after 20:00 (20:30 EDT)', US(2026, 6, 1, 0, 30)  === 'closed'); // 00:30 UTC Jul1 = 20:30 EDT Jun30

// Weekend → closed, with an "opens" label.
const wknd = marketSession('US', Date.UTC(2026, 5, 27, 14, 0)); // Sat 2026-06-27, 10:00 EDT
ok('US weekend closed', wknd.phase === 'closed');
ok('US closed shows regular-open label', /09:30/.test(wknd.nextOpen || ''), JSON.stringify(wknd.nextOpen));
ok('US open state has no nextOpen', marketSession('US', Date.UTC(2026, 5, 30, 14, 0)).nextOpen === null);

// JSE has no extended hours ⇒ only open/closed, never pre/post.
ok('JSE open (10:00 SAST)',  JSE(2026, 5, 30, 8, 0)  === 'open');
ok('JSE open at 09:30 (no pre tier)', JSE(2026, 5, 30, 7, 30) === 'open');
ok('JSE closed before open (08:00 SAST)', JSE(2026, 5, 30, 6, 0) === 'closed');

// CRYPTO is always open, even on the weekend; no nextOpen.
ok('CRYPTO always open', marketSession('CRYPTO', Date.UTC(2026, 5, 27, 3, 0)).phase === 'open');
ok('CRYPTO nextOpen null', marketSession('CRYPTO').nextOpen === null);

// marketOpen must be UNCHANGED by the new regOpen/regClose fields (US window 04:00–20:00).
ok('marketOpen US regular still true', marketOpen('US', new Date(Date.UTC(2026, 5, 30, 14, 0))) === true);  // 10:00 EDT
ok('marketOpen US night still false',  marketOpen('US', new Date(Date.UTC(2026, 5, 30, 7, 0)))  === false); // 03:00 EDT

console.log(failures ? `\n${failures} test(s) failed` : '\nAll market-session tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend/test && node market-session.test.mjs`
Expected: FAIL — `exports marketSession` is false (fn not defined yet).

- [ ] **Step 3: Extend `SESSIONS.US`** — in `pb-core.js` line 25, change:

```js
    US:   { tz: 'America/New_York',    open: 4 * 60,  close: 20 * 60 },     // incl. pre/post
```

to:

```js
    US:   { tz: 'America/New_York',    open: 4 * 60,  close: 20 * 60, regOpen: 9 * 60 + 30, regClose: 16 * 60 }, // open/close incl. pre/post; regOpen/regClose = regular session
```

- [ ] **Step 4: Implement the kernel** — in `pb-core.js`, immediately after the `anyMarketOpen` function (after its closing `}` on line 62, before the `// market:ticker price-map key` comment on line 64), insert:

```js

  // Market-local { weekday short, minutes-since-midnight } for an instant, via
  // Intl (DST-correct). Same parse shape marketOpen uses inline.
  function localWeekdayMins(tz, now) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now);
    const get = t => parts.find(p => p.type === t)?.value;
    let hh = parseInt(get('hour'), 10);
    if (hh === 24) hh = 0;
    return { wd: get('weekday'), mins: hh * 60 + parseInt(get('minute'), 10) };
  }

  // "09:30 EDT" — the regular-open minute formatted with the market's CURRENT tz
  // abbreviation (DST-correct at `now`). Used for the "Closed · opens …" badge.
  function fmtOpenLabel(tz, openMins, now) {
    const hh = String(Math.floor(openMins / 60)).padStart(2, '0');
    const mm = String(openMins % 60).padStart(2, '0');
    let abbr = '';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(now));
      abbr = parts.find(p => p.type === 'timeZoneName')?.value || '';
    } catch (_e) {}
    return abbr ? `${hh}:${mm} ${abbr}` : `${hh}:${mm}`;
  }

  // Per-symbol market-session phase + the regular-open label, clock-derived (no
  // holiday calendar — same limitation as marketOpen). phase ∈
  // 'pre'|'open'|'post'|'closed'. Markets without regOpen/regClose have no
  // extended hours, so their whole [open,close] window is 'open'.
  function marketSession(market, now = Date.now()) {
    if (market === 'CRYPTO') return { phase: 'open', nextOpen: null };
    const s = SESSIONS[market] || SESSIONS.US;
    try {
      const { wd, mins } = localWeekdayMins(s.tz, now);
      const weekend = wd === 'Sat' || wd === 'Sun';
      let phase;
      if (weekend || mins < s.open || mins >= s.close) {
        phase = 'closed';
      } else {
        const regOpen = typeof s.regOpen === 'number' ? s.regOpen : s.open;
        const regClose = typeof s.regClose === 'number' ? s.regClose : s.close;
        if (mins < regOpen) phase = 'pre';
        else if (mins >= regClose) phase = 'post';
        else phase = 'open';
      }
      const regOpen = typeof s.regOpen === 'number' ? s.regOpen : s.open;
      return { phase, nextOpen: phase === 'closed' ? fmtOpenLabel(s.tz, regOpen, now) : null };
    } catch (_e) {
      return { phase: 'open', nextOpen: null }; // Intl failure → assume open (don't show a false "Closed")
    }
  }
```

- [ ] **Step 5: Export it** — in the `const PBCore = {` block, add `marketSession,` immediately after `anyMarketOpen,` (line 500):

```js
    anyMarketOpen,
    marketSession,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend/test && node market-session.test.mjs`
Expected: PASS — `All market-session tests passed` (exit 0).

- [ ] **Step 7: Sanity-check the module parses**

Run: `node --check pb-core.js`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add pb-core.js backend/test/market-session.test.mjs
git commit -m "Add pure marketSession kernel + regular-session boundaries to pb-core.js (refresh-confidence UX)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Add the pure `fmtAgo` + `refreshChipState` helpers to `pb-core.js`

The relative-time string and the chip state machine are pure presentational logic → node-testable in isolation, keeping the JSX thin.

**Files:**
- Modify: `pb-core.js` — add `fmtAgo` + `refreshChipState` after `marketSession` (Task 1); add both to the `PBCore` object.
- Test: `backend/test/refresh-chip.test.mjs` (new)

**Interfaces:**
- Produces: `PBCore.fmtAgo(fromMs, nowMs = Date.now()) => string` — `'just now'` (<5 s) | `'Ns ago'` | `'Nm ago'` | `'Nh ago'` | `'Nd ago'`; `''` for non-finite `fromMs`.
- Produces: `PBCore.refreshChipState({ loading, lastUpdateMs, failStreak, pendingAck, lastManual, justSucceeded, nowMs }) => { phase, text, dot }`
  - `phase`: `'updating' | 'error' | 'success' | 'idle' | 'loading'`.
  - `dot`: `'loading' | 'stale' | 'live'` (existing CSS dot classes).
  - `text`: the chip label string.

- [ ] **Step 1: Write the failing test** — create `backend/test/refresh-chip.test.mjs`:

```js
// Unit tests for the pure fmtAgo + refreshChipState helpers in pb-core.js
// (refresh-confidence UX).   cd backend/test && node refresh-chip.test.mjs
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };
const { fmtAgo, refreshChipState } = PBCore;

ok('exports fmtAgo', typeof fmtAgo === 'function');
ok('exports refreshChipState', typeof refreshChipState === 'function');

// fmtAgo coarsens with age.
ok('fmtAgo just now (0s)',  fmtAgo(1000, 1000) === 'just now');
ok('fmtAgo just now (<5s)', fmtAgo(0, 4000)  === 'just now');
ok('fmtAgo seconds',        fmtAgo(0, 12000) === '12s ago');
ok('fmtAgo minutes',        fmtAgo(0, 3 * 60000) === '3m ago');
ok('fmtAgo hours',          fmtAgo(0, 2 * 3600000) === '2h ago');
ok('fmtAgo days',           fmtAgo(0, 49 * 3600000) === '2d ago');
ok('fmtAgo invalid → empty', fmtAgo(null, 1000) === '');

// refreshChipState priority: updating > error > success > idle(ago) > loading.
ok('cold start → Loading…', refreshChipState({ loading: false, lastUpdateMs: null }).text === 'Loading…');
ok('loading → Updating…', refreshChipState({ loading: true, lastUpdateMs: 123 }).phase === 'updating');
ok('pendingAck → Updating… (instant ack)', refreshChipState({ loading: false, pendingAck: true, lastUpdateMs: 123 }).phase === 'updating');
ok('manual fail shows error immediately', refreshChipState({ failStreak: 1, lastManual: true, lastUpdateMs: 123 }).phase === 'error');
ok('auto fail at 1 does NOT show error', refreshChipState({ failStreak: 1, lastManual: false, lastUpdateMs: 123 }).phase === 'idle');
ok('auto fail at 2 shows error', refreshChipState({ failStreak: 2, lastManual: false, lastUpdateMs: 123 }).phase === 'error');
ok('success flash → Updated ✓', refreshChipState({ justSucceeded: true, lastUpdateMs: 123 }).text === 'Updated ✓');
ok('steady state → Updated Ns ago', refreshChipState({ lastUpdateMs: 0, nowMs: 12000 }).text === 'Updated 12s ago');
ok('error dot is stale', refreshChipState({ failStreak: 2, lastUpdateMs: 1 }).dot === 'stale');
ok('idle dot is live', refreshChipState({ lastUpdateMs: 0, nowMs: 1000 }).dot === 'live');

console.log(failures ? `\n${failures} test(s) failed` : '\nAll refresh-chip tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend/test && node refresh-chip.test.mjs`
Expected: FAIL — `exports fmtAgo` / `exports refreshChipState` are false.

- [ ] **Step 3: Implement both helpers** — in `pb-core.js`, immediately after the `marketSession` function added in Task 1, insert:

```js

  // Relative "time since" for the freshness chip; coarsens as it ages so the
  // user always sees movement within a few seconds of a refresh.
  function fmtAgo(fromMs, nowMs = Date.now()) {
    if (typeof fromMs !== 'number' || !isFinite(fromMs)) return '';
    const sec = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }

  // The status chip's display state, resolved from the price feed's existing
  // signals plus a small ack/flash. Priority: in-flight/just-pressed (Updating…)
  // beats a failure, which beats the brief success flash, which beats the steady
  // "Updated Ns ago", which beats the cold-start "Loading…". A MANUAL failure
  // shows immediately (the user just asked); a background-poll failure waits for
  // failStreak ≥ 2 so a single transient blip doesn't cry wolf.
  function refreshChipState({ loading = false, lastUpdateMs = null, failStreak = 0, pendingAck = false, lastManual = false, justSucceeded = false, nowMs = Date.now() } = {}) {
    if (loading || pendingAck) return { phase: 'updating', text: 'Updating…', dot: 'loading' };
    const failed = lastManual ? failStreak >= 1 : failStreak >= 2;
    if (failed) return { phase: 'error', text: "Couldn't refresh — tap to retry", dot: 'stale' };
    if (justSucceeded) return { phase: 'success', text: 'Updated ✓', dot: 'live' };
    if (typeof lastUpdateMs === 'number' && isFinite(lastUpdateMs)) {
      return { phase: 'idle', text: `Updated ${fmtAgo(lastUpdateMs, nowMs)}`, dot: 'live' };
    }
    return { phase: 'loading', text: 'Loading…', dot: 'loading' };
  }
```

- [ ] **Step 4: Export both** — in the `const PBCore = {` block, add them after `marketSession,` (added in Task 1):

```js
    marketSession,
    fmtAgo,
    refreshChipState,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend/test && node refresh-chip.test.mjs`
Expected: PASS — `All refresh-chip tests passed` (exit 0).

- [ ] **Step 6: Sanity-check the module parses**

Run: `node --check pb-core.js`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add pb-core.js backend/test/refresh-chip.test.mjs
git commit -m "Add pure fmtAgo + refreshChipState helpers to pb-core.js (refresh-confidence UX)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Rework the status chip in `app.js` (ticking + states + instant ack)

Bind the three pure fns, add one shared `useNow()` clock + a little ack/flash state, and turn the chip into a ticking interactive retry control. Pin it with browser-smoke assertions and append the anti-drift guard rows.

**Files:**
- Modify: `app.js` — binds (after line 1735); `useNow` (before `function usePriceFeed`, ~line 1735-ish region, top-level); ack/flash state + effects + `onChipRefresh` + `chipState` (after the `usePriceFeed(...)` call + inc-3 view effect, ~line 2896); chip JSX (lines 3280-3290); the refresh icon-button onClick (line 3292).
- Modify: `backend/test/verify-refresh-behavior.mjs` (chip assertions before `ws.close()`); `backend/test/market-session.test.mjs` + `backend/test/refresh-chip.test.mjs` (append anti-drift rows).

**Interfaces:**
- Consumes: `PBCore.marketSession` / `fmtAgo` / `refreshChipState` (Tasks 1-2); the existing `usePriceFeed` returns `{ prices, loading, lastUpdate, failStreak, refreshNow: refreshPricesNow, mergePrices }`.
- Produces: `useNow(intervalMs) => number` (a ticking epoch-ms), `onChipRefresh()` (sets ack + manual flag, calls `refreshPricesNow`), and `chipState` (from `refreshChipState`) used by the chip JSX.

- [ ] **Step 1: Bind the three pure fns** — in `app.js`, after line 1735 (`const anyMarketOpen = PBCore.anyMarketOpen;`), add:

```js
const marketSession = PBCore.marketSession;
const fmtAgo = PBCore.fmtAgo;
const refreshChipState = PBCore.refreshChipState;
```

- [ ] **Step 2: Add the `useNow` hook** — in `app.js`, immediately before `function usePriceFeed(` (line 1735 area — place it just above that declaration), insert:

```js
// One shared ticking clock so the freshness chip can re-render "Updated Ns ago"
// without touching the price feed. ~5s cadence is plenty (the chip never needs
// sub-5s precision); this is the only timer the refresh-confidence UX adds.
function useNow(intervalMs = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
```

- [ ] **Step 3: Add chip state + effects + handler.** In `app.js`, immediately AFTER the inc-3 view effect that follows the `usePriceFeed(fetchOrder, fetchKey, toast)` call (~line 2896), insert:

```js
  // ---- Refresh-confidence chip state (presentational; derived from the feed) ----
  const nowTick = useNow(5000);
  const [pendingAck, setPendingAck] = useState(false);     // a press we haven't resolved yet
  const [lastManual, setLastManual] = useState(false);     // most recent trigger was a user tap
  const [justSucceeded, setJustSucceeded] = useState(false); // brief "Updated ✓" flash
  const lastUpdateMs = lastUpdate ? lastUpdate.getTime() : null;
  // A tap acknowledges instantly (chip → Updating…) even if a sweep is mid-flight
  // and the press is queued; routes both the chip and the header refresh button.
  const onChipRefresh = () => { setPendingAck(true); setLastManual(true); refreshPricesNow(); };
  // lastUpdate only moves on SUCCESS (a failed sweep leaves it unchanged), so a
  // change here means fresh data landed: flash ✓ for 2s and clear ack/manual.
  useEffect(() => {
    if (lastUpdateMs == null) return;
    setJustSucceeded(true);
    setPendingAck(false);
    setLastManual(false);
    const t = setTimeout(() => setJustSucceeded(false), 2000);
    return () => clearTimeout(t);
  }, [lastUpdateMs]);
  // A failed sweep bumps failStreak without moving lastUpdate — clear the ack so
  // the chip doesn't sit on "Updating…" forever; the error state takes over.
  useEffect(() => {
    if (failStreak > 0) setPendingAck(false);
  }, [failStreak]);
  const chipState = refreshChipState({ loading, lastUpdateMs, failStreak, pendingAck, lastManual, justSucceeded, nowMs: nowTick });
```

- [ ] **Step 4: Rework the chip JSX.** Replace the status-chip element (lines 3280-3290) — from `React.createElement("div", {` / `className: "status-chip",` through `}) : '…'))` — with:

old:
```js
React.createElement("div", {
    className: "status-chip",
    title: failStreak >= 2
      ? 'Price feed failing — last successful update shown'
      : (lastUpdate ? 'Last refresh ' + lastUpdate.toLocaleTimeString() : 'Loading…')
  }, React.createElement("span", {
    className: `dot ${loading ? 'loading' : failStreak >= 2 ? 'stale' : lastUpdate ? 'live' : 'loading'}`
  }), React.createElement("span", null, lastUpdate ? lastUpdate.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  }) : '…'))
```

new:
```js
React.createElement("div", {
    className: "status-chip",
    role: "button",
    tabIndex: 0,
    onClick: onChipRefresh,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChipRefresh(); } },
    title: chipState.phase === 'error'
      ? 'Price feed failing — tap to retry'
      : (lastUpdate ? 'Last refresh ' + lastUpdate.toLocaleTimeString() : 'Loading…'),
    "aria-label": chipState.text
  }, React.createElement("span", {
    className: `dot ${chipState.dot}`
  }), React.createElement("span", null, chipState.text))
```

- [ ] **Step 5: Route the header refresh button through the same ack.** At line 3292, change:

```js
    onClick: refreshPricesNow,
```

to:

```js
    onClick: onChipRefresh,
```

(This is the `icon-btn ... "aria-label": "Refresh"` button immediately after the chip — line 3290-3293.)

- [ ] **Step 6: Parse-check**

Run: `node --check app.js`
Expected: no output, exit 0.

- [ ] **Step 7: Add the chip browser-smoke assertions.** In `backend/test/verify-refresh-behavior.mjs`, immediately before the final `ws.close();`, insert:

```js

  // ---- REFRESH-CONFIDENCE CHIP: live relative time + instant tap ack ----
  const chipText0 = await evals(ws, `return document.querySelector('.status-chip')?.innerText || '';`);
  ok('status chip shows relative/state text (not bare HH:MM)', /ago|just now|Updating|Updated|Loading/i.test(chipText0), JSON.stringify(chipText0));
  await evals(ws, `const c=document.querySelector('.status-chip'); if(c) c.click(); return true;`);
  const chipText1 = await evals(ws, `return document.querySelector('.status-chip')?.innerText || '';`);
  ok('tapping the chip flips to Updating… instantly', /Updating/i.test(chipText1), JSON.stringify(chipText1));
  await sleep(3000);
  const chipText2 = await evals(ws, `return document.querySelector('.status-chip')?.innerText || '';`);
  ok('chip settles to Updated/relative after the sweep', /Updated|ago/i.test(chipText2), JSON.stringify(chipText2));
```

- [ ] **Step 8: Append anti-drift rows to the node suites.** At the top of BOTH `backend/test/market-session.test.mjs` and `backend/test/refresh-chip.test.mjs`, add the `app.js` source read just under `import PBCore from '../../pb-core.js';`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app.js'), 'utf8');
```

In `market-session.test.mjs`, immediately before its final `console.log(...)`, add:

```js
ok('app.js binds marketSession from PBCore', /const\s+marketSession\s*=\s*PBCore\.marketSession/.test(appSrc));
ok('app.js has no local function marketSession', !/function\s+marketSession\s*\(/.test(appSrc));
```

In `refresh-chip.test.mjs`, immediately before its final `console.log(...)`, add:

```js
ok('app.js binds fmtAgo from PBCore', /const\s+fmtAgo\s*=\s*PBCore\.fmtAgo/.test(appSrc));
ok('app.js binds refreshChipState from PBCore', /const\s+refreshChipState\s*=\s*PBCore\.refreshChipState/.test(appSrc));
ok('app.js has no local function fmtAgo / refreshChipState', !/function\s+fmtAgo\s*\(/.test(appSrc) && !/function\s+refreshChipState\s*\(/.test(appSrc));
```

- [ ] **Step 9: Run both node suites (now fully green incl. anti-drift)**

Run: `cd backend/test && node market-session.test.mjs && node refresh-chip.test.mjs`
Expected: both end `All ... tests passed` (exit 0).

- [ ] **Step 10: Run the browser smoke (chip rows GREEN)**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: `ALL PASSED`, including the three new chip rows. (If Chrome isn't at the harness's `CHROME` path, update that constant first.)

- [ ] **Step 11: Commit**

```bash
git add app.js backend/test/verify-refresh-behavior.mjs backend/test/market-session.test.mjs backend/test/refresh-chip.test.mjs
git commit -m "Rework status chip: live 'Updated Ns ago', Updating/Updated/Couldn't-refresh states + instant tap ack (refresh-confidence UX)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Add the per-symbol `SessionBadge` + render it; styles; SW bump

Render a small Pre-market/Open/After-hours/Closed badge wherever the shared `PriceBlock` (and the watchlist card) gate ext display on `hasExt`, so a closed/quiet symbol shows its state instead of nothing.

**Files:**
- Modify: `app.js` — `SessionBadge` (top-level, immediately before `function PriceBlock`); one render line inside `PriceBlock` (between lines 3650-3655); one render block in the watchlist card (before line 7475).
- Modify: `styles.css` — add `.session-badge` rules after line 1895.
- Modify: `sw.js` — cache v34 → v35 (line 2).
- Modify: `backend/test/verify-refresh-behavior.mjs` — session-badge assertion before `ws.close()`.

**Interfaces:**
- Consumes: `marketSession` (bound in Task 3), a `quote` object (may carry `extKind`), and `market`.
- Produces: `SessionBadge({ market, quote })` — a React element (or `null` for CRYPTO).

- [ ] **Step 1: Add the `SessionBadge` component.** In `app.js`, immediately before `function PriceBlock(` (the price renderer whose body is at lines ~3585-3665), insert:

```js
// Per-symbol market-session badge. When Yahoo reports a live ext session with a
// move, quote.extKind ('pre'/'post') is authoritative; otherwise fall back to the
// clock kernel (which also catches a pre session with no move yet, and weekends/
// overnight as 'closed'). Renders nothing for CRYPTO (always open).
function SessionBadge({ market, quote }) {
  if (market === 'CRYPTO') return null;
  const ext = quote && (quote.extKind === 'pre' || quote.extKind === 'post') ? quote.extKind : null;
  const { phase, nextOpen } = ext ? { phase: ext, nextOpen: null } : marketSession(market);
  const label = phase === 'pre' ? 'Pre-market'
    : phase === 'post' ? 'After-hours'
    : phase === 'open' ? 'Open'
    : (nextOpen ? `Closed · opens ${nextOpen}` : 'Closed');
  return React.createElement("div", { className: `session-badge session-${phase}` },
    React.createElement("span", { className: "session-dot" }),
    React.createElement("span", { className: "session-label" }, label));
}
```

- [ ] **Step 2: Render the badge in `PriceBlock`.** The badge fills the gap when there's no ext-price chip. In `app.js`, find the unique anchor (the daily-block child close + the compact-ext comment, lines 3650-3651):

old:
```js
  ),
  // Outside the detail card (rows/lists): compact ext-hours chip — label, live
```

new:
```js
  ),
  // Per-symbol session badge — fills the gap when there's no ext-price chip
  // (regular/closed hours, or a pre/post session with no move yet) so a quiet
  // quote still shows its market state. hideExt callers (watchlist) render their own.
  !hasExt && !hideExt && React.createElement(SessionBadge, { market: market, quote: quote }),
  // Outside the detail card (rows/lists): compact ext-hours chip — label, live
```

- [ ] **Step 3: Render the badge in the watchlist card.** In `app.js`, before the existing `hasExt && ...watch-ext ext-hours...` block (lines 7473-7475):

old:
```js
            // Pre/after-hours readout on its own centered line at the foot of the
            // card so it reads as a secondary detail without crowding the name.
            hasExt && React.createElement("div", { className: "watch-ext ext-hours" },
```

new:
```js
            // Session badge (Open/Closed/Pre/After) so a quiet card reads as
            // market state, not blank. Shown only when the ext-price chip isn't.
            !hasExt && React.createElement("div", { className: "watch-ext" },
              React.createElement(SessionBadge, { market: w.market, quote: q })),
            // Pre/after-hours readout on its own centered line at the foot of the
            // card so it reads as a secondary detail without crowding the name.
            hasExt && React.createElement("div", { className: "watch-ext ext-hours" },
```

- [ ] **Step 4: Add the badge styles.** In `styles.css`, immediately after line 1895 (`.ext-chg.down { color: var(--rose); }`), insert:

```css

/* Per-symbol market-session badge (refresh-confidence UX). Mirrors .ext-label
   sizing; the dot colour encodes the session phase. */
.session-badge {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--mono); font-size: 9px;
  letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700;
  color: var(--text-dim);
}
.session-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-dim); flex-shrink: 0; }
.session-open   .session-dot { background: var(--emerald); }
.session-pre    .session-dot,
.session-post   .session-dot { background: var(--amber); }
.session-closed .session-dot { background: var(--text-dim); }
.session-open { color: var(--emerald); }
.session-pre, .session-post { color: var(--amber); }
```

- [ ] **Step 5: Bump the SW cache version.** In `sw.js` line 2, change:

```js
const CACHE_NAME   = 'playbook-shell-v34';
```

to:

```js
const CACHE_NAME   = 'playbook-shell-v35';
```

- [ ] **Step 6: Add the session-badge browser-smoke assertion.** In `backend/test/verify-refresh-behavior.mjs`, immediately before the final `ws.close();` (after the chip rows from Task 3), insert:

```js

  // ---- PER-SYMBOL SESSION BADGE: a closed/quiet market reads as state, not blank ----
  await evals(ws, `const d=document.querySelector('button[data-tab="dashboard"]'); if(d) d.click(); return true;`);
  await sleep(800);
  const badge = await evals(ws, `const b=document.querySelector('.session-badge'); return b ? b.innerText : null;`);
  ok('a session badge renders (Open/Closed/Pre-market/After-hours)', !!badge && /Open|Closed|Pre-market|After-hours/i.test(badge), JSON.stringify(badge));
```

- [ ] **Step 7: Parse-check**

Run: `node --check app.js`
Expected: no output, exit 0.

- [ ] **Step 8: Run the full node suite**

Run: `cd backend/test && for t in *.test.mjs; do echo "== $t =="; node "$t" || break; done`
Expected: every suite ends `All ... passed` / `tests passed` (14 suites: the 12 prior + `market-session` + `refresh-chip`).

- [ ] **Step 9: Run the browser smoke (badge row GREEN)**

Run: `node backend/test/verify-refresh-behavior.mjs`
Expected: `ALL PASSED`, including the session-badge row (on a weekend run the badge reads `Closed`).

- [ ] **Step 10: Commit**

```bash
git add app.js styles.css sw.js backend/test/verify-refresh-behavior.mjs
git commit -m "Add per-symbol SessionBadge (Pre/Open/After/Closed) + styles; SW v34→v35 (refresh-confidence UX)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Cross-view coverage check + finalize

Confirm no quote renders without a badge where it should, the tree is clean, and update the memories.

**Files:**
- No code changes unless a defect is found.
- Update (outside the repo, no commit): `playbook-postponed-tasks` and `playbook-refactor-priorities` memory files.

- [ ] **Step 1: Grep for ext/price render sites to confirm badge coverage.**

Run:
```bash
grep -nE "ext-hours|hasExt|extLabel" app.js
```
Expected: the only quote-rendering sites that gate on `hasExt` are `PriceBlock` (lines ~3594-3664, now with the Step-2 badge) and the watchlist card (~7422-7480, now with the Step-3 badge). If a THIRD site renders a quote/ext without a sibling `SessionBadge`, add one there the same way (wrap in `.watch-ext`/inline, `!hasExt && React.createElement(SessionBadge, { market, quote })`) — don't ship a view that still goes blank when closed.

- [ ] **Step 2: Full parse + suite + smoke (final gate).**

Run:
```bash
node --check pb-core.js && node --check app.js
cd backend/test && for t in *.test.mjs; do echo "== $t =="; node "$t" || break; done
node backend/test/verify-refresh-behavior.mjs
```
Expected: parses clean; all node suites pass; browser smoke `ALL PASSED` (chip rows + badge row included).

- [ ] **Step 3: Confirm the working tree is clean.**

Run: `git status --porcelain`
Expected: empty (all task commits made on `feature/refresh-confidence-ux`).

- [ ] **Step 4: Update the memories** (files live outside the repo — no git commit):
  - `playbook-postponed-tasks.md`: mark task #3 (refresh-confidence UX, root cause B) **DONE** — live ticking "Updated Ns ago" + Updating/Updated ✓/Couldn't-refresh-tap-to-retry + instant tap ack + per-symbol Pre/Open/After/Closed session badge; root cause A (fan-out) already shipped in inc 3. Keep the optional Worker-side shared quote cache (P1/Phase 5) deferred. Note the premarket "regression" was diagnosed as **the weekend** (no bug), now made legible by the session badge.
  - `playbook-refactor-priorities.md`: add a short entry — refresh-confidence UX increment landed atop Phase 2 inc 3 on branch `feature/refresh-confidence-ux`; pure `marketSession`/`fmtAgo`/`refreshChipState` added to pb-core (node suite now 14); `SESSIONS.US` gained `regOpen`/`regClose`; sw v34→v35; no worker impact.

---

## Self-Review

**Spec coverage:**
- §1a live "Updated Ns ago" → `fmtAgo` (Task 2) + `useNow` + `chipState` wiring (Task 3). ✓
- §1b action states (Updating/Updated ✓/Couldn't refresh, manual-immediate vs auto≥2, success-even-if-unchanged) → `refreshChipState` (Task 2) + the lastUpdate/failStreak effects (Task 3). ✓
- §1c instant press ack → `pendingAck` + `onChipRefresh` + both triggers routed through it (Task 3). ✓
- §1d per-symbol badge (pre/open/post/closed, extKind-refines-clock, "opens HH:MM", no CRYPTO) → `marketSession` (Task 1) + `SessionBadge` + render sites (Task 4). ✓
- §2 architecture: pure kernel + `SESSIONS.US` regOpen/regClose (Task 1), pure chip helpers (Task 2), binds + `useNow` + chip rework (Task 3), badge + styles (Task 4). ✓
- §3 edge cases: cold start → Loading… (Task 2 test); extKind-vs-clock fallback (Task 4 SessionBadge); DST via Intl (Task 1); success vs failure keyed off lastUpdate moving (Task 3 effects); non-US tz label via Intl (Task 1 `fmtOpenLabel`); no cadence/order change (no feed edits). ✓
- §4 testing: node `market-session` + `refresh-chip` suites + extended browser smoke (chip rows + badge row) + anti-drift guards. ✓
- §5 mechanics: pb-core + app.js + styles.css edits, sw v34→v35, no new file ⇒ no allowlist change, no worker impact. ✓
- §6 increment breakdown (kernel → chip → badge → verify) maps to Tasks 1-5. ✓

**Placeholder scan:** no TBD/TODO/"add error handling". Every code step shows exact old/new text or full new code. The only conditional step (Task 5 Step 1) gives the exact remediation if a third render site is found — not a placeholder.

**Type consistency:** `marketSession(market, now) → { phase, nextOpen }` defined in Task 1, consumed identically in `SessionBadge` (Task 4). `refreshChipState({...}) → { phase, text, dot }` defined in Task 2, consumed as `chipState.dot`/`chipState.text`/`chipState.phase` in Task 3. `fmtAgo(fromMs, nowMs)` defined Task 2, used inside `refreshChipState` only. `useNow(intervalMs) → number` defined Task 3 Step 2, used as `nowTick` in Step 3. `onChipRefresh()` defined Task 3 Step 3, referenced by the chip (Step 4) and the icon-button (Step 5). All `dot` values (`'loading'|'stale'|'live'`) match existing `styles.css` classes (lines 152-155).
