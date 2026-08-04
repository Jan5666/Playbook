// ─── Playbook shared core ────────────────────────────────────────────────────
// The ONE source of truth for the app's pure, side-effect-free logic — no React,
// no DOM, no network. It began as the home for the two pieces that used to be
// copy-pasted (and had drifted) between the client (app.js) and the push backend
// (backend/worker.js): market-hours and price-alert evaluation. An alert must
// behave identically whether it's evaluated in the foreground app or by the
// server while the app is closed — so both import this. It now also holds the
// market-symbol/price-unit helpers (shared with the worker) and pure money math
// (e.g. cost-basis averaging) that only the client uses but belongs out of the
// 14k-line app.js where it can be tested in isolation.
//
// No build step on the frontend, so this is a plain classic script with a
// dual-mode footer: CommonJS `module.exports` (so the Worker bundler and the
// Node tests can `import` it) AND `globalThis.PBCore` (so the browser can load it
// via <script src> before app.js). It uses only cross-platform globals
// (Date, Intl, isFinite), so it runs unchanged in the browser, on Cloudflare
// Workers, and in Node.
"use strict";
(function () {
  // Re-arm window after a hit clears; also the "don't re-fire" guard window.
  const TRIGGER_COOLDOWN_MS = 5 * 60 * 1000;

  // ─── Market hours (DST-correct via Intl time zones) ──────────────────────────
  const SESSIONS = {
    US:   { tz: 'America/New_York',    open: 4 * 60,  close: 20 * 60, regOpen: 9 * 60 + 30, regClose: 16 * 60 }, // open/close incl. pre/post; regOpen/regClose = regular session
    JSE:  { tz: 'Africa/Johannesburg', open: 9 * 60,  close: 17 * 60 + 5 },
    TFSA: { tz: 'Africa/Johannesburg', open: 9 * 60,  close: 17 * 60 + 5 },
    LSE:  { tz: 'Europe/London',       open: 8 * 60,  close: 16 * 60 + 35 },
    ASX:  { tz: 'Australia/Sydney',    open: 10 * 60, close: 16 * 60 + 10 },
    FRA:  { tz: 'Europe/Berlin',       open: 9 * 60,  close: 17 * 60 + 35 },
    PAR:  { tz: 'Europe/Paris',        open: 9 * 60,  close: 17 * 60 + 35 },
    AMS:  { tz: 'Europe/Amsterdam',    open: 9 * 60,  close: 17 * 60 + 35 },
    CRYPTO: { tz: 'UTC',               open: 0,       close: 24 * 60, alwaysOpen: true }
  };

  function marketOpen(market, now = new Date()) {
    if (market === 'CRYPTO') return true; // 24/7, incl. weekends
    const s = SESSIONS[market] || SESSIONS.US;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: s.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(now);
      const get = t => parts.find(p => p.type === t)?.value;
      const wd = get('weekday');
      if (wd === 'Sat' || wd === 'Sun') return false;
      let hh = parseInt(get('hour'), 10);
      if (hh === 24) hh = 0; // some ICU builds emit 24 for midnight
      const mins = hh * 60 + parseInt(get('minute'), 10);
      return mins >= s.open && mins <= s.close;
    } catch (_e) { return true; } // if Intl tz fails, assume open (poll/check normally)
  }

  function anyMarketOpen(items) {
    if (!items || items.length === 0) return true; // nothing tracked yet → treat as open
    const seen = new Set();
    for (const it of items) {
      if (seen.has(it.market)) continue;
      seen.add(it.market);
      if (marketOpen(it.market)) return true;
    }
    return false;
  }

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
      const regOpen = typeof s.regOpen === 'number' ? s.regOpen : s.open;
      const regClose = typeof s.regClose === 'number' ? s.regClose : s.close;
      let phase;
      if (weekend || mins < s.open || mins >= s.close) {
        phase = 'closed';
      } else {
        if (mins < regOpen) phase = 'pre';
        else if (mins >= regClose) phase = 'post';
        else phase = 'open';
      }
      return { phase, nextOpen: phase === 'closed' ? fmtOpenLabel(s.tz, regOpen, now) : null };
    } catch (_e) {
      return { phase: 'open', nextOpen: null }; // Intl failure → assume open (don't show a false "Closed")
    }
  }

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
  // Has `market`'s REGULAR session begun on its own current local day? This is
  // deliberately NOT a marketSession() phase check: the JSE at 18:00 SAST is
  // 'closed', but it plainly traded today and must keep counting until the
  // viewer's day rolls over. Only the START of the regular session matters.
  // Pre/after-hours are excluded on purpose -- before the regular open a quote's
  // price is still yesterday's close, so its day move is yesterday's move.
  function regularSessionStartedToday(market, nowMs = Date.now()) {
    if (market === 'CRYPTO') return true; // 24/7, incl. weekends
    const s = SESSIONS[market] || SESSIONS.US;
    try {
      const { wd, mins } = localWeekdayMins(s.tz, new Date(nowMs));
      if (wd === 'Sat' || wd === 'Sun') return false;
      return mins >= (typeof s.regOpen === 'number' ? s.regOpen : s.open);
    } catch (_e) { return true; } // Intl failure: fail open, matching marketOpen
  }
  // Quote-level wrapper: the market must have opened for its regular session,
  // AND the quote's own last tick must fall on the viewer's current local day.
  // Sources with no tick timestamp (e.g. Stooq) fall back to the session clock.
  function quoteTradedToday(quote, market, nowMs = Date.now()) {
    if (!quote) return false;
    // A market contributes nothing to "Today" until its regular session opens.
    // Yahoo's regularMarketTime cannot answer this: a single pre-market print
    // stamps today's date hours before the open, which is exactly how
    // yesterday's whole US session used to land in the SA morning's "Today".
    // We derive the answer from SESSIONS instead of trusting the feed.
    if (!regularSessionStartedToday(market, nowMs)) return false;
    if (typeof quote.regularMarketTime === 'number' && isFinite(quote.regularMarketTime)) {
      return tradedToday(quote.regularMarketTime, nowMs);
    }
    return marketSession(market, nowMs).phase === 'open';
  }

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

  // market:ticker price-map key — shared so app.js and pb-data.js can't drift.
  function priceKey(market, ticker) { return market + ':' + ticker; }

  // Two-tier price-fetch planner (Phase 2 inc 3). Given the user's own tiers (in
  // priority order), the lazy per-view lists, the set of already-visited (warmed)
  // lazy views, and the active view, returns:
  //   order — the de-duped fetch list as {market,ticker}, with the ACTIVE lazy
  //           list floated to the front so what's on screen refreshes first,
  //           then the fast tiers, then any other warmed lazy lists.
  //   key   — the FAST-TIER membership signature (sorted, joined). It excludes the
  //           lazy lists on purpose, so reordering (a tab switch) or warming a new
  //           lazy list never changes it — only a change to the user's own universe
  //           does. Callers use it as the "refetch when this changes" key.
  function buildFetchPlan({ fastTiers = [], lazyLists = {}, warmed, activeView } = {}) {
    const warmedSet = warmed instanceof Set ? warmed : new Set(warmed || []);
    const seen = new Set();
    const orderedKeys = [];
    const push = (k) => { if (k && !seen.has(k)) { seen.add(k); orderedKeys.push(k); } };
    // 1. Active lazy list first (only if the active view actually is a lazy list).
    if (activeView && lazyLists[activeView]) lazyLists[activeView].forEach(push);
    // 2. Fast tiers in their given priority order.
    fastTiers.forEach(tier => (tier || []).forEach(push));
    // 3. Remaining warmed lazy lists (the active one is already in).
    warmedSet.forEach(v => { if (v !== activeView && lazyLists[v]) lazyLists[v].forEach(push); });
    // key: fast-tier price-keys only, de-duped + sorted so it is order-independent.
    const fastSeen = new Set();
    fastTiers.forEach(tier => (tier || []).forEach(k => { if (k) fastSeen.add(k); }));
    const key = Array.from(fastSeen).sort().join(',');
    const order = orderedKeys.map(k => { const i = k.indexOf(':'); return { market: k.slice(0, i), ticker: k.slice(i + 1) }; });
    return { order, key };
  }

  // ─── Price-alert evaluation ──────────────────────────────────────────────────
  // Pure state machine, identical to what both engines already ran:
  //   waiting → (price crosses target) → fire once, record { status:'hit', at }.
  //   hit → stays hit while the condition holds; once it clears it holds the hit
  //   state through the cooldown, then re-arms to 'waiting' so it can fire again.
  //
  // `prices` maps "MARKET:TICKER" → a NUMBER (the live price). The client passes
  // its quote objects' `.price` (and drops stale quotes before calling, which the
  // server doesn't need to since it fetches fresh). Returns the next seen-map, any
  // newly-fired triggers, and whether persisted state changed (so the caller can
  // skip a write when nothing moved).
  function evaluateAlerts(alerts, prices, seen, opts) {
    opts = opts || {};
    const now = opts.now != null ? opts.now : Date.now();
    const cooldownMs = opts.cooldownMs != null ? opts.cooldownMs : TRIGGER_COOLDOWN_MS;
    seen = seen || {};
    const nextSeen = {};
    const newTriggers = [];
    let changed = false;
    for (const a of (alerts || [])) {
      // Inactive, missing-price, or malformed-target alerts: carry prior state
      // forward untouched, never fire.
      if (!a.active) { if (seen[a.id] !== undefined) nextSeen[a.id] = seen[a.id]; continue; }
      const px = prices[a.market + ':' + a.ticker];
      if (px == null || !isFinite(px)) { if (seen[a.id] !== undefined) nextSeen[a.id] = seen[a.id]; continue; }
      if (typeof a.targetPrice !== 'number' || !isFinite(a.targetPrice)) { if (seen[a.id] !== undefined) nextSeen[a.id] = seen[a.id]; continue; }
      const hit = a.direction === 'above' ? px >= a.targetPrice : px <= a.targetPrice;
      const prior = seen[a.id] !== undefined ? seen[a.id] : 'waiting';
      if (hit) {
        if (prior === 'waiting') {
          nextSeen[a.id] = { status: 'hit', at: now };
          newTriggers.push({ ...a, triggerPrice: px, triggeredAt: new Date(now).toISOString() });
          changed = true;
        } else {
          nextSeen[a.id] = prior; // already hit — no re-fire
        }
      } else {
        if (typeof prior === 'object' && prior !== null && (now - prior.at) < cooldownMs) {
          nextSeen[a.id] = prior; // still cooling down — hold the hit state
        } else {
          nextSeen[a.id] = 'waiting';
          if (prior !== 'waiting') changed = true; // re-armed
        }
      }
    }
    // Dropped keys (alerts removed) count as a change so the caller prunes them.
    if (!changed) for (const k in seen) if (!(k in nextSeen)) { changed = true; break; }
    return { nextSeen, newTriggers, changed };
  }

  // ─── Market symbols & price units ────────────────────────────────────────────
  // Lifted verbatim from app.js (the canonical, richer copies) so the client and
  // the Worker build the SAME Yahoo symbol and apply the SAME cent/pence divisor.
  // Both previously kept crude, drifted duplicates: the Worker fetched the wrong
  // instrument for ^SPX/^VIX and mis-scaled some JSE/LSE units — which can fire an
  // alert the foreground app never would. These are pure (only encodeURIComponent
  // + RegExp + String), so they run unchanged in browser, Worker, and Node.
  function centDivisor(market, currency) {
    const raw = currency || '';
    const c = raw.toUpperCase();
    // Market-independent minor units Yahoo emits regardless of which market the
    // user filed the symbol under: "GBp"/"GBX" (UK pence), "ZAc"/"ZAX" (SA cents).
    // A trailing lowercase letter on an otherwise GB*/ZA* code is the pence/cents
    // convention; catching it here means a London listing accidentally fetched
    // under "US" still shows a sane magnitude instead of a 100x-inflated price.
    if (c === 'GBX' || c === 'ZAX' || c === 'ZAC') return 100;
    if (/[a-z]$/.test(raw) && /^(GB|ZA)/.test(c)) return 100;
    const isJseCent = (market === 'JSE' || market === 'TFSA') && (c === 'ZAC' || c === 'ZAR' && /[cC]$/.test(raw));
    const isLseGBX = market === 'LSE' && c === 'GBX';
    // Yahoo sometimes returns "GBp" (mixed case) for pence-denominated LSE
    // instruments, but also plain "GBP" for pound-denominated ones. Treat any
    // lowercase-p suffix as pence, and conservatively treat bare "GBP" on LSE
    // tickers that report via the .L suffix as pence too — the chart endpoint
    // almost always returns values in pence for LSE.
    const isLseGBp = market === 'LSE' && (c === 'GBP' && /[pP]$/.test(raw));
    const isLseBareGBP = market === 'LSE' && raw === 'GBP';
    return (isJseCent || isLseGBX || isLseGBp || isLseBareGBP) ? 100 : 1;
  }
  // JSE and TFSA are the SAME underlying exchange — a TFSA is a tax wrapper around
  // JSE-listed instruments, not a separate venue — so both build the identical
  // Yahoo symbol (.JO), settle in the same currency (ZAR), and apply the same
  // cent divisor. Anything that decides "is this listing on the market the user
  // chose?" must ask this, never `a === b`: strict equality made every live JSE
  // search result look off-market to a TFSA row, so listings that exist and price
  // perfectly well reported "no match" purely because of the account label.
  function sameUnderlyingExchange(a, b) {
    if (a === b) return true;
    const norm = m => (m === 'TFSA' ? 'JSE' : m);
    return norm(a) === norm(b);
  }
  function yahooSymbol(ticker, market) {
    if (market === 'JSE' || market === 'TFSA') return ticker + '.JO';
    if (market === 'LSE') return ticker + '.L';
    if (market === 'ASX') return ticker + '.AX';
    if (market === 'FRA') return ticker + '.F';
    if (market === 'PAR') return ticker + '.PA';
    if (market === 'AMS') return ticker + '.AS';
    // Crypto is held as a bare symbol (BTC, ETH); Yahoo prices it as a USD pair.
    // Guard against a symbol that already carries the pair so we never double it.
    if (market === 'CRYPTO') return /-USD$/i.test(ticker) ? encodeURIComponent(ticker) : encodeURIComponent(ticker + '-USD');
    if (ticker === '^SPX') return '%5EGSPC';
    if (ticker === '^VIX') return '%5EVIX';
    if (ticker === '^GSPC') return '%5EGSPC';
    return encodeURIComponent(ticker);
  }

  // ─── Concurrency limiter ─────────────────────────────────────────────────────
  // Minimal promise concurrency limiter: returns limited(fn) that runs at most
  // `concurrency` fns at once. Pure (no globals) — pb-data uses it to cap
  // simultaneous fetch() calls across all proxied requests.
  function pLimit(concurrency) {
    const queue = [];
    let active = 0;
    const next = () => {
      while (active < concurrency && queue.length) {
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve().then(fn).then(
          (v) => { active--; resolve(v); next(); },
          (e) => { active--; reject(e); next(); }
        );
      }
    };
    return function limited(fn) {
      return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
    };
  }

  // ─── Money / FX / position valuation (pure, client-only) ─────────────────────
  // The app's money math, moved out of the 14k-line app.js so it can be tested in
  // isolation. MARKET_CURRENCY maps each market to its native currency (display
  // symbol + ISO code); the helpers reason in those codes against an fx rate map
  // ("source units per USD", with USD === 1).
  const MARKET_CURRENCY = {
    US:   { sym: '$',   code: 'USD', label: 'USD' },
    JSE:  { sym: 'R',   code: 'ZAR', label: 'ZAR' },
    TFSA: { sym: 'R',   code: 'ZAR', label: 'ZAR' },
    LSE:  { sym: '£',  code: 'GBP', label: 'GBP' },
    ASX:  { sym: 'A$',  code: 'AUD', label: 'AUD' },
    FRA:  { sym: '€',  code: 'EUR', label: 'EUR' },
    PAR:  { sym: '€',  code: 'EUR', label: 'EUR' },
    AMS:  { sym: '€',  code: 'EUR', label: 'EUR' },
    // Crypto is quoted against USD (Yahoo's BTC-USD pairs), so it shares the
    // dollar for display and FX conversion just like the US market.
    CRYPTO: { sym: '$', code: 'USD', label: 'USD' },
  };
  function convertCcy(amount, from, to, rates) {
    if (amount == null || !isFinite(amount)) return null;
    if (!from || !to || from === to) return amount;
    if (!rates) return null;
    const fr = rates[from];
    const tr = rates[to];
    if (!fr || !tr) return null;
    return amount / fr * tr;
  }
  // The capital a deposit actually committed, valued in `displayCurrency`. This is
  // the "money put in" used for overall-profit: it uses the rate locked when the
  // deposit was made — the real achieved rate when the user recorded how much USD
  // actually landed (fxRateAtContrib = source units ÷ USD landed), otherwise the
  // market rate at deposit time — rather than revaluing at today's market rate. So
  // a deposit kept in the display currency always counts at its face amount, and a
  // cross-currency deposit counts at the dollars that genuinely entered the
  // account. Falls back to today's conversion only when no rate was ever captured.
  function contribInDisplay(c, displayCurrency, rates) {
    if (!c) return 0;
    const amt = c.amount;
    if (!isFinite(amt)) return 0;
    if (c.currency === displayCurrency) return amt;
    const lockedRate = (c.fxRateAtContrib && isFinite(c.fxRateAtContrib) && c.fxRateAtContrib > 1e-6) ? c.fxRateAtContrib : null;
    const dispRate = (rates && rates[displayCurrency] && isFinite(rates[displayCurrency]) && rates[displayCurrency] > 1e-6) ? rates[displayCurrency] : null;
    if (lockedRate && dispRate) {
      const usd = amt / lockedRate; // the USD that actually landed at deposit time
      return usd * dispRate;        // revalue that committed USD into the display currency
    }
    const conv = convertCcy(amt, c.currency, displayCurrency, rates);
    return conv != null ? conv : 0;
  }
  function marketCurrency(market) {
    return (MARKET_CURRENCY[market] || MARKET_CURRENCY.US).code;
  }
  // The currency a position's cost basis is denominated in. Defaults to the
  // market's native currency, so every holding that predates the crypto-in-ZAR
  // feature (and any holding without an explicit costCurrency) behaves exactly as
  // before. Crypto bought on a ZAR exchange carries costCurrency:'ZAR' even though
  // the live price feed is in USD — letting the user keep what they actually paid.
  function positionCostCcy(p) {
    return (p && p.costCurrency) || marketCurrency(p ? p.market : 'US');
  }
  // Value a position in its own cost currency: cost is already in that currency,
  // and the live price (quoted in the market's native currency) is converted into
  // it. When the cost currency equals the native currency this is a no-op, so the
  // returned figures match the pre-existing same-currency math bit-for-bit.
  function valuePositionInCostCcy(p, quote, rates) {
    const native = marketCurrency(p.market);
    const ccy = positionCostCcy(p);
    const cost = p.shares * p.costBasis;
    let value = null;
    if (quote && isFinite(quote.price)) {
      value = ccy === native
        ? p.shares * quote.price
        : convertCcy(p.shares * quote.price, native, ccy, rates);
    }
    const gain = value != null ? value - cost : null;
    const gainPct = (value != null && cost > 0) ? (value - cost) / cost * 100 : null;
    return { ccy, native, cost, value, gain, gainPct };
  }
  // Sum per-position daily value series into one portfolio series, carrying
  // each position's last known value across calendar dates where it has no bar.
  // Mixed-exchange portfolios (US/JSE/LSE holiday calendars differ) otherwise
  // undercount on any date where only a subset of holdings traded — the
  // recurring downward spikes on the Growth Tracker. Input: [{ entryDate:
  // 'YYYY-MM-DD'|null, points: [{ d: 'YYYY-MM-DD', v: number }] }] (values
  // pre-converted to the display currency by the caller; a later point for the
  // same date wins). Output: [{ date, value }] ascending; a position
  // contributes from its first bar at/after entryDate through the final date.
  function forwardFillPortfolio(positionSeries) {
    const list = Array.isArray(positionSeries) ? positionSeries : [];
    const dates = new Set();
    const series = [];
    for (const s of list) {
      if (!s || !Array.isArray(s.points)) continue;
      const entry = typeof s.entryDate === 'string' && s.entryDate ? s.entryDate : null;
      const byDate = new Map();
      for (const pt of s.points) {
        if (!pt || typeof pt.d !== 'string' || typeof pt.v !== 'number' || !isFinite(pt.v)) continue;
        if (entry && pt.d < entry) continue;
        byDate.set(pt.d, pt.v);
      }
      if (byDate.size === 0) continue;
      for (const d of byDate.keys()) dates.add(d);
      series.push(byDate);
    }
    const all = [...dates].sort();
    const last = series.map(() => null);
    return all.map(d => {
      let value = 0;
      for (let i = 0; i < series.length; i++) {
        if (series[i].has(d)) last[i] = series[i].get(d);
        if (last[i] != null) value += last[i];
      }
      return { date: d, value };
    });
  }
  function resolvePositionUpdates(existing, updates, ctx) {
    const next = { ...updates };
    if (!existing) return next;
    const nextMarket = updates.market || existing.market;
    const nextDate = updates.purchaseDate != null ? updates.purchaseDate : existing.purchaseDate;
    const marketChanged = updates.market != null && updates.market !== existing.market;
    const dateChanged = updates.purchaseDate != null && updates.purchaseDate !== existing.purchaseDate;
    const costCcyChanged = updates.costCurrency !== undefined && (updates.costCurrency || null) !== (existing.costCurrency || null);
    // Only touch the stored cost-basis FX rate when the date, market, or cost
    // currency actually moved — a plain shares/cost edit must leave it untouched.
    if (!marketChanged && !dateChanged && !costCcyChanged) return next;
    // The rate tracks whichever currency the cost basis is denominated in.
    const fxCode = (updates.costCurrency !== undefined ? updates.costCurrency : existing.costCurrency) || marketCurrency(nextMarket);
    if (nextDate && nextDate !== ctx.today && ctx.historicalFx != null) {
      next.fxRateAtCost = ctx.historicalFx;
    } else if ((!nextDate || nextDate === ctx.today) && ctx.fxRates?.rates?.[fxCode]) {
      next.fxRateAtCost = ctx.fxRates.rates[fxCode];
    }
    return next;
  }

  // ─── Cost basis (pure money math, client-only) ───────────────────────────────
  // The one true copy of the blended-average-cost formula that app.js used to
  // inline in THREE places (startup dedup, addPosition top-up, importPositions
  // bulk merge). Given an existing holding (exShares @ exCost, in its own cost
  // currency) and an incoming lot (addShares @ addCost, ALREADY converted into
  // that same currency by the caller), returns the merged { shares, costBasis }.
  // FX conversion of addCost and all non-numeric glue (notes/name/fxRateAtCost)
  // stay with the caller. The shares<=0 guard (from importPositions) avoids a
  // divide-by-zero, falling back to the existing cost.
  function mergeCostBasis(exShares, exCost, addShares, addCost) {
    const shares = exShares + addShares;
    const costBasis = shares > 0
      ? (exShares * exCost + addShares * addCost) / shares
      : exCost;
    return { shares, costBasis };
  }

  // ─── Yahoo chart parsers (pure, client-only) ─────────────────────────────────
  // Normalize Yahoo's v8 chart payloads into the app's quote shape. Pure given the
  // core helpers above (MARKET_CURRENCY, centDivisor, SESSIONS); the worker keeps
  // its own tiny inline parse, so these are client-only. deriveIntradayExt takes an
  // optional `now` (ms) so its pre/post-session classification is testable.
  function buildDailyBars(result, divisor) {
    const ts = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const bars = [];
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i];
      if (typeof c !== 'number' || !isFinite(c) || c <= 0) continue;
      const tsec = ts[i];
      bars.push({ t: typeof tsec === 'number' ? tsec * 1000 : null, p: c / divisor });
    }
    return bars;
  }
  // The market-local calendar day (YYYY-MM-DD) a timestamp falls on. This is what
  // makes "today" mean each market's OWN trading day — a US bar is dated in New
  // York, a JSE bar in Johannesburg — instead of the viewer's wall clock. Without
  // this, a South-African user (UTC+2) judging a US stock's "yesterday" by their
  // local midnight gets the day boundary wrong and the previous close drifts a
  // session, which is exactly the "USA/SA days confused" symptom.
  function marketDayKey(ms, market) {
    const tz = (SESSIONS[market] || SESSIONS.US).tz;
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(ms));
    } catch (_e) { return null; }
  }
  // Yahoo's regularMarketPreviousClose is often stale, in the wrong unit, or
  // missing — which produces an inflated %-change. Derive it from the daily bars
  // instead, anchored to the market's OWN trading day: the last bar is the current
  // session (today's partial/closed bar, or the last completed session when the
  // market is shut), so the previous close is the most recent bar that lands on an
  // EARLIER market-local day. We deliberately key off the day, not price-equality
  // to the live tick — a <1% "flat" day (routine for ETFs/large caps) used to make
  // the old equals-live guard skip the real previous close and reach a session too
  // far back, doubling the reported "today" move.
  // The ratio guard (0.01x–100x) only rejects unit mismatches (cents vs dollars),
  // never real moves, so genuine flash crashes/halts still pass through.
  function derivePrevClose(bars, livePrice, fallback, market) {
    if (!Array.isArray(bars) || bars.length < 2 || !(livePrice > 0)) return fallback;
    const lastBar = bars[bars.length - 1];
    const curDay = lastBar.t != null ? marketDayKey(lastBar.t, market) : null;
    let candidate = null;
    for (let i = bars.length - 2; i >= 0; i--) {
      const b = bars[i];
      // Skip any bar sharing the current session's market-local day; the first
      // earlier-day bar carries the genuine previous close.
      if (curDay != null && b.t != null && marketDayKey(b.t, market) === curDay) continue;
      candidate = b.p;
      break;
    }
    if (candidate == null) candidate = bars[bars.length - 2].p;
    if (!(candidate > 0) || !isFinite(candidate)) return fallback;
    const ratio = candidate / livePrice;
    if (ratio > 0.01 && ratio < 100) return candidate;
    return fallback;
  }
  // The day move, with `price` and `prevClose` guaranteed to bracket ONE regular
  // session — the market's own open→close (or open→live while it trades). This is
  // the whole fix for "Oracle reads +11% when Yahoo says +9%".
  //
  // derivePrevClose above assumes the LAST bar is the session `price` belongs to.
  // That assumption breaks in one direction each way, and both were shipping:
  //   - Before a market's open, Yahoo's daily chart has no bar for today, so the
  //     last bar is YESTERDAY's and the loop skips to the close from TWO sessions
  //     back. Pair that with a price spliced from the pre-market and the chip
  //     reported yesterday's whole move PLUS today's pre-market move.
  //   - Just after an open, Yahoo may not have printed today's bar yet, so a live
  //     price gets measured against the wrong session's close.
  // Resolving the session FIRST and picking the previous close relative to it
  // closes both. Returns { price, prevClose, sessionDay }; sessionDay is the
  // market-local day `price` belongs to, which is what the Dashboard's "Today"
  // gate already keys on.
  function deriveDayMove(bars, livePrice, fallback, market, opts = {}) {
    const now = opts.now != null ? opts.now : Date.now();
    const lastTick = opts.lastTick;
    const out = { price: livePrice, prevClose: fallback, sessionDay: null };
    if (!Array.isArray(bars) || !bars.length || !(livePrice > 0)) return out;
    const todayKey = marketDayKey(now, market);
    const lastBar = bars[bars.length - 1];
    const lastDay = lastBar.t != null ? marketDayKey(lastBar.t, market) : null;
    // "Did the feed print a tick on `day`?" Unknown answers NO on purpose: the
    // branch it guards claims `price` is TODAY's live price, and asserting that
    // without evidence is the risky direction — it would measure a stale price
    // against the wrong session. Real Yahoo quotes always carry
    // regularMarketTime, so only degenerate responses take the cautious path.
    const tickedOn = (tickMs, day) => {
      if (typeof tickMs !== 'number' || !isFinite(tickMs) || day == null) return false;
      return marketDayKey(tickMs, market) === day;
    };
    // Is the last bar recent enough to BE the previous session? A 5d chart's last
    // bar is at most a long weekend old; anything older means the series itself is
    // stale (illiquid or delisted symbol, a cached proxy response), and treating
    // an ancient close as "yesterday" would silently report a 0% day.
    const LAST_BAR_MAX_AGE_MS = 5 * 86400 * 1000;
    const lastBarRecent = lastBar.t != null && (now - lastBar.t) < LAST_BAR_MAX_AGE_MS;
    // Most recent bar landing on a market-local day EARLIER than `day`.
    const closeBefore = (day, stopIdx) => {
      for (let i = stopIdx; i >= 0; i--) {
        const b = bars[i];
        if (day != null && b.t != null && marketDayKey(b.t, market) === day) continue;
        return b.p;
      }
      return null;
    };
    let candidate = null;
    if (lastDay != null && todayKey != null && lastDay === todayKey) {
      // Today's session is on the chart — `price` belongs to it.
      out.sessionDay = todayKey;
      candidate = closeBefore(lastDay, bars.length - 2);
    } else if (lastBarRecent && regularSessionStartedToday(market, now) && tickedOn(lastTick, todayKey)) {
      // The regular session has opened today but Yahoo hasn't printed its daily
      // bar yet: `price` is today's live price, so the last bar IS the previous
      // close. (Without this the previous close lands a session too far back.)
      // `tickedOn` is what keeps market HOLIDAYS out of this branch — the clock
      // says the session opened, but nothing traded, so there is no "today" to
      // measure and the last completed session's move is the honest reading.
      out.sessionDay = todayKey;
      candidate = lastBar.p;
    } else {
      // Market shut / not yet open: `price` is the last completed session's close,
      // and the move to show is that session's own — Yahoo shows the same.
      out.sessionDay = lastDay;
      candidate = closeBefore(lastDay, bars.length - 2);
    }
    // No earlier-day bar anywhere → the caller's fallback (Yahoo's own
    // chartPreviousClose) wins. Deliberately NOT the adjacent bar: on an intraday
    // chart every bar shares one day, so "the bar before" is the previous MINUTE
    // and the day move would collapse to ~0.00%.
    if (candidate == null || !(candidate > 0) || !isFinite(candidate)) return out;
    // Same unit-mismatch guard as derivePrevClose (cents vs dollars); real moves,
    // including flash crashes and halts, pass through untouched.
    const ratio = candidate / livePrice;
    if (ratio > 0.01 && ratio < 100) out.prevClose = candidate;
    return out;
  }
  // ─── Live-quote plausibility guard (merge path) ─────────────────────────────
  // Yahoo intermittently reports an unexpected meta.currency for a pence/cents
  // listing; centDivisor then returns 1 and the whole quote arrives ~100x off
  // (price AND prevClose share the divisor, so the quote is internally
  // consistent — only comparison against the last accepted quote can catch it).
  // guardQuote gates such a jump at the store-merge seam: the bogus quote is
  // held back (the last good one keeps rendering, with the contested level
  // recorded as `suspect`) until a later fetch confirms the new level for at
  // least QUOTE_CONFIRM_MS — a real split/consolidation persists and is
  // accepted within minutes, a one-poll glitch never renders at all. The value
  // math (valuePositionInCostCcy) stays clamp-free by design; see
  // backend/test/quote-guard.test.mjs.
  const QUOTE_JUMP_MAX_RATIO = 20;        // > this vs last accepted price = implausible
  const QUOTE_CONFIRM_RATIO = 2;          // a repeat within this of the suspect level confirms it
  const QUOTE_CONFIRM_MS = 5 * 60 * 1000; // suspect must persist this long to be believed
  const QUOTE_GUARD_STALE_MS = 3 * 24 * 3600 * 1000; // don't second-guess moves across a long gap
  function plausiblePriceMove(prevPrice, nextPrice) {
    if (!(prevPrice > 0) || !(nextPrice > 0) || !isFinite(prevPrice) || !isFinite(nextPrice)) return true;
    const r = nextPrice / prevPrice;
    return r < QUOTE_JUMP_MAX_RATIO && r > 1 / QUOTE_JUMP_MAX_RATIO;
  }
  function guardQuote(prev, next, nowMs) {
    if (!next || typeof next.price !== 'number' || !isFinite(next.price) || next.price <= 0) return { quote: next, rejected: false };
    if (!prev || typeof prev.price !== 'number' || !isFinite(prev.price) || prev.price <= 0) return { quote: next, rejected: false };
    const now = nowMs != null ? nowMs : Date.now();
    if (!prev.fetchedAt || now - prev.fetchedAt > QUOTE_GUARD_STALE_MS) return { quote: next, rejected: false };
    if (plausiblePriceMove(prev.price, next.price)) return { quote: next, rejected: false };
    const s = prev.suspect;
    const matchesSuspect = !!(s && isFinite(s.price) && s.price > 0 &&
      next.price / s.price < QUOTE_CONFIRM_RATIO && next.price / s.price > 1 / QUOTE_CONFIRM_RATIO);
    if (matchesSuspect && now - s.at >= QUOTE_CONFIRM_MS) return { quote: next, rejected: false };
    // Keep the original sighting time while the same level keeps arriving so
    // the confirmation clock runs from first sight, not the latest poll.
    const suspect = matchesSuspect ? s : { price: next.price, at: now };
    return { quote: Object.assign({}, prev, { suspect }), rejected: true };
  }
  // Resolve an intraday chart result's own pre/regular/post windows.
  //
  // Anchored to meta.tradingPeriods — it describes the returned bars' OWN day — in
  // preference to currentTradingPeriod, which rolls to the NEXT session at exchange
  // midnight (a Saturday fetch would look for Friday's post bars inside Monday's
  // windows and find nothing). When only ctp exists, its windows are walked back a
  // day at a time until they cover the last bar (day-length shifts; a DST boundary
  // can skew that fallback by an hour, which only matters the two weekends a year
  // tradingPeriods is also absent).
  //
  // Returns null when the result carries no usable regular window.
  function resolveTradingWindows(result) {
    const meta = result?.meta;
    const ts = result?.timestamp;
    if (!meta || !Array.isArray(ts) || !ts.length) return null;
    const validPeriod = (p) => p && typeof p.start === 'number' && typeof p.end === 'number' ? p : null;
    // tradingPeriods object form: { pre: [[p]], regular: [[p]], post: [[p]] } with
    // one inner array per returned day — take the most recent day's windows.
    let pre = null, regular = null, post = null;
    const tp = meta.tradingPeriods;
    if (tp && !Array.isArray(tp) && Array.isArray(tp.regular) && tp.regular.length) {
      const lastDay = (arr) => (Array.isArray(arr) && arr.length && Array.isArray(arr[arr.length - 1]))
        ? validPeriod(arr[arr.length - 1][0]) : null;
      regular = lastDay(tp.regular);
      pre = lastDay(tp.pre);
      post = lastDay(tp.post);
    }
    if (!regular) {
      const ctp = meta.currentTradingPeriod;
      if (!ctp || !validPeriod(ctp.regular)) return null;
      pre = validPeriod(ctp.pre); regular = validPeriod(ctp.regular); post = validPeriod(ctp.post);
      const lastBar = ts[ts.length - 1];
      const DAY = 86400;
      const shift = (p) => p ? { start: p.start - DAY, end: p.end - DAY } : null;
      let guard = 0;
      while (guard++ < 5 && typeof lastBar === 'number' && lastBar < (pre ? pre.start : regular.start)) {
        pre = shift(pre); regular = shift(regular); post = shift(post);
      }
    }
    return { pre, regular, post };
  }
  // Latest non-null close inside [win.start, win.end) → { close, at } (`at` in
  // seconds, matching Yahoo's timestamps). null when the window holds no bar.
  function lastCloseInWindow(ts, closes, win) {
    if (!win || !Array.isArray(ts) || !Array.isArray(closes)) return null;
    for (let i = ts.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (c == null || !isFinite(c)) continue;
      if (ts[i] < win.start || ts[i] >= win.end) continue;
      return { close: c, at: ts[i] };
    }
    return null;
  }
  // Derive the extended-hours (pre/post) quote from an intraday chart result.
  // Yahoo's chart `meta` no longer carries preMarketPrice/postMarketPrice and the
  // v7 quote endpoint that did is now blocked — so the only reliable source is the
  // intraday bars themselves (fetched with includePrePost). Two modes come out of
  // one classification:
  //  - LIVE (extLive: true): "now" is inside the pre or post window. Latest traded
  //    close in that session vs the regular close — exactly the figure Google
  //    shows as "Pre-market" / "After hours".
  //  - FINAL (extLive: false): the market is fully closed after a post session
  //    (overnight, weekend, pre-dawn before the next pre-market prints). The post
  //    session's LAST trade vs that day's close — this keeps "what happened after
  //    the close" readable the next morning instead of vanishing at the post bell.
  // Regular hours still return null (the daily change is the live figure), as do
  // symbols with no genuine ext activity (bars forward-filled at the close).
  //
  // Session windows come from resolveTradingWindows (see there for the
  // tradingPeriods-over-currentTradingPeriod anchoring rule).
  //
  // The baseline the ext move is measured against is the last close INSIDE the
  // regular window — deliberately not meta.regularMarketPrice. Yahoo's
  // `regularMarketPrice` is the last TRADED price, so during a live pre/post
  // session it is the extended-hours price itself; measuring against it compared
  // the session to itself and collapsed every ext readout to ~0.00%. The bar-
  // derived close is the real regular close, so the figure now matches what
  // Google/Yahoo label "After hours" / "Pre-market".
  //
  // A PRE session is the case the chart alone cannot answer: a range=1d intraday
  // result covers only today, whose regular window is still empty at 06:00, so the
  // baseline has to be YESTERDAY's close. Callers pass it as `opts.regularClose`
  // (in display units, i.e. divisor already applied) — that is exactly the daily
  // quote's price. meta.regularMarketPrice is the last resort, and during a live
  // ext session it is the wrong number, which is why it ranks last.
  function deriveIntradayExt(result, market, now = Date.now(), opts = {}) {
    const meta = result?.meta;
    const ts = result?.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!meta || !Array.isArray(ts) || !Array.isArray(closes) || !ts.length) return null;
    if (typeof meta.regularMarketPrice !== 'number') return null;
    const wins = resolveTradingWindows(result);
    if (!wins || !wins.regular) return null;
    const { pre, regular, post } = wins;
    const currency = meta.currency || (MARKET_CURRENCY[market]?.code || 'USD');
    const divisor = centDivisor(market, currency);
    const regBar = lastCloseInWindow(ts, closes, regular);
    // Raw (pre-divisor) regular close, so the forward-fill comparison below stays
    // in the bars' own units. opts.regularClose arrives already divided, hence the
    // multiply back.
    const suppliedRaw = (opts.regularClose > 0 && isFinite(opts.regularClose))
      ? opts.regularClose * divisor : null;
    const regRaw = regBar ? regBar.close : (suppliedRaw != null ? suppliedRaw : meta.regularMarketPrice);
    const nowSec = now / 1000;
    let kind = null, sess = null, live = false;
    if (post && nowSec >= post.start && nowSec < post.end) { kind = 'post'; sess = post; live = true; }
    else if (pre && nowSec >= pre.start && nowSec < pre.end) { kind = 'pre'; sess = pre; live = true; }
    else if (post && nowSec >= post.end) { kind = 'post'; sess = post; live = false; }
    else return null;
    // Latest non-null close inside the active extended session = the live ext
    // price. Yahoo's chart API leaves `volume` null on pre/post minute bars
    // (only the closing-auction bar carries volume), so "did it really trade
    // after hours" can't be read from volume. We infer a genuine ext session
    // from price ACTIVITY instead: a live session moves the close off the
    // regular close, whereas a symbol with no after-hours market is forward-
    // filled flat at that close.
    let raw = null;      // latest in-window close → the live ext price
    let moved = false;   // any in-window close that differs from the reg close
    let asOfSec = null;  // timestamp of that latest in-window close
    for (let i = ts.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (c == null || !isFinite(c)) continue;
      if (ts[i] < sess.start || ts[i] >= sess.end) continue;
      if (raw == null) { raw = c; asOfSec = ts[i]; }
      // Relative epsilon rather than !==: when the baseline came from
      // opts.regularClose it made a divisor round-trip, so a genuinely flat
      // forward-filled bar can miss exact equality by a float ulp.
      if (Math.abs(c - regRaw) > Math.abs(regRaw) * 1e-9) moved = true;
      if (raw != null && moved) break;
    }
    if (raw == null) return null;
    // No genuine after-hours activity (every bar forward-filled at the close) →
    // nothing meaningful to show. We deliberately do NOT gate on the *size* of
    // the move: a stock trading flat (±0.01%) after hours is still real, live
    // information, and hiding small moves is exactly what made the readout appear
    // for some holdings (movers) but not others (steady names).
    if (!moved) return null;
    const extPrice = raw / divisor;
    const regularPrice = regRaw / divisor;
    if (!(regularPrice > 0) || !(extPrice > 0)) return null;
    const out = {
      extPrice,
      extChange: extPrice - regularPrice,
      extChangePct: (extPrice - regularPrice) / regularPrice * 100,
      extKind: kind,
      extLive: live,
      extAsOf: asOfSec != null ? asOfSec * 1000 : null,
      // The regular session's own close, carried out so callers get a trustworthy
      // regular price from the SAME response — this is what the day move is
      // anchored to while the market sits in pre/post (meta.regularMarketPrice
      // would be the ext price there). null when the window held no bar.
      regPrice: regBar ? regBar.close / divisor : null,
      regAsOf: regBar ? regBar.at * 1000 : null
    };
    // Only a LIVE session may assert PRE/POST; the final (session-over) reading
    // deliberately omits marketState so callers spreading this object never
    // overwrite the real market state (CLOSED) with a stale session flag.
    if (live) out.marketState = kind === 'post' ? 'POST' : 'PRE';
    return out;
  }
  // Convert one Yahoo chart result into the app's normalized quote shape.
  // Returns null if the response shape is unusable so the caller can fall
  // through to the next proxy or data source.
  // `opts.now` makes the session classification testable; `opts.regularPrice`
  // lets a caller that already has a bar-derived regular price (the intraday
  // path, via deriveIntradayExt's regPrice) override meta.regularMarketPrice.
  function parseYahooQuote(result, market, opts = {}) {
    const meta = result?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
    const now = opts.now != null ? opts.now : Date.now();
    let currency = meta.currency || (MARKET_CURRENCY[market]?.code || 'USD');
    const divisor = centDivisor(market, currency);
    let price = meta.regularMarketPrice;
    let prevClose = meta.regularMarketPreviousClose != null ? meta.regularMarketPreviousClose
      : (meta.previousClose != null ? meta.previousClose
      : (meta.chartPreviousClose != null ? meta.chartPreviousClose : price));
    let yearHigh = meta.fiftyTwoWeekHigh || null;
    let yearLow = meta.fiftyTwoWeekLow || null;
    let dayHigh = meta.regularMarketDayHigh || null;
    let dayLow = meta.regularMarketDayLow || null;
    const volume = meta.regularMarketVolume || null;
    if (divisor !== 1) {
      price = price / divisor;
      prevClose = prevClose / divisor;
      if (yearHigh) yearHigh = yearHigh / divisor;
      if (yearLow) yearLow = yearLow / divisor;
      if (dayHigh) dayHigh = dayHigh / divisor;
      if (dayLow) dayLow = dayLow / divisor;
    }
    // The market the user filed this symbol under is authoritative for the display
    // currency. Normalise to it so every surface (price, fundamentals, P/L, chart)
    // shows one consistent symbol instead of trusting whatever listing Yahoo
    // resolved a bare ticker to — that mismatch is what made US holdings
    // occasionally render in £/€. Falls back to Yahoo's value for unknown markets.
    currency = (MARKET_CURRENCY[market] && MARKET_CURRENCY[market].code) || currency;
    const bars = buildDailyBars(result, divisor);
    // `price` must be a REGULAR-session price before the day move is built from
    // it. meta.regularMarketPrice is the last TRADED price, so in pre/post it is
    // the extended-hours price — using it there folded after-hours movement into
    // "Today" (Oracle: +11.18% against Yahoo's +9.00%). While the market is in
    // its regular session that field is both live and genuinely regular, so it
    // stays; otherwise the last daily bar (a completed regular close) wins.
    // Callers holding a bar-derived regular price pass it in as opts.regularPrice.
    const lastTick = typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : null;
    const lastBar = bars.length ? bars[bars.length - 1] : null;
    // The >=2-bars condition keeps one invariant: price and prevClose come from
    // the SAME source. A single-bar result (range=1d, or a sparse listing) has no
    // series to derive a previous close from, so prevClose falls back to meta —
    // and the price must then come from meta too, or the pair straddles sources.
    if (opts.regularPrice > 0 && isFinite(opts.regularPrice)) {
      price = opts.regularPrice;
    } else if (market !== 'CRYPTO' && bars.length >= 2 && marketSession(market, now).phase !== 'open') {
      price = lastBar.p;
    }
    // `price` and `prevClose` are resolved together so they always bracket the
    // SAME regular session; sessionDay records which one, for the "Today" gates.
    let sessionDay = lastBar && lastBar.t != null ? marketDayKey(lastBar.t, market) : null;
    try {
      const move = deriveDayMove(bars, price, prevClose, market, { now, lastTick });
      prevClose = move.prevClose;
      if (move.sessionDay != null) sessionDay = move.sessionDay;
    } catch (_e) {}
    return {
      price,
      prevClose,
      change: price - prevClose,
      changePct: prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0,
      yearHigh,
      yearLow,
      dayHigh,
      dayLow,
      volume,
      // Extended-hours (pre/post) is derived from intraday bars by the caller via
      // deriveIntradayExt — the daily chart meta carries no pre/post fields.
      extPrice: null,
      extChange: null,
      extChangePct: null,
      extKind: null,
      extLive: null,
      extAsOf: null,
      currency,
      marketState: meta.marketState || 'UNKNOWN',
      shortName: meta.shortName || meta.longName || null,
      longName: meta.longName || meta.shortName || null,
      // Upstream timestamp (in ms) of the most recent price tick. Callers use
      // this to detect stale data — fetchedAt only tracks when WE saw it, which
      // can drift far from the actual market clock when an upstream feed lags.
      regularMarketTime: typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : null,
      sessionDay,
      fetchedAt: Date.now(),
      source: 'yahoo'
    };
  }

// Parse a possibly comma-decimalled / thousands-separated string to a number.
// Returns NaN when there's no usable numeric content.
function parseDecimal(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  // Strip currency symbols / spaces / letters but keep separators and sign.
  s = s.replace(/[^0-9.,\-]/g, '');
  if (!s) return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // Whichever separator appears last is the decimal separator.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    // A lone comma: decimal if it looks like one (e.g. 12,50), else thousands.
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length !== 3) s = parts[0] + '.' + parts[1];
    else s = s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : NaN;
}

// ─── Yahoo fundamentals-timeseries parser ─────────────────────────────────
// Parses query1.finance.yahoo.com/ws/fundamentals-timeseries/v1 payloads into
// the app's fundamentals shape. This endpoint (the one Yahoo's own statistics
// page uses) is NOT crumb-gated like v10 quoteSummary, so it still works
// through the CORS-proxy chain — it's the keyless fallback when
// stockanalysis.com is unreachable. Pure: safe to unit-test in Node.
//
// Payload shape (one result entry per requested type; arrays are chronological
// and may contain nulls for padded periods):
//   { timeseries: { result: [ { meta: { type: ["annualTotalRevenue"] },
//       annualTotalRevenue: [ { asOfDate: "2025-09-30", currencyCode: "USD",
//         reportedValue: { raw: 4.16e11, fmt: "416.16B" } }, ... ] } ] } }
function parseFundamentalsTimeseries(json, market) {
  const results = json?.timeseries?.result;
  if (!Array.isArray(results)) return null;
  // latest[type] = { v, asOfDate, ccy }; prevAnnual[type] = value before latest
  // (for YoY growth on annual statement items).
  const latest = {};
  const prevAnnual = {};
  for (const entry of results) {
    const type = entry?.meta?.type?.[0];
    if (!type || !Array.isArray(entry[type])) continue;
    const rows = entry[type].filter(r => r && r.reportedValue && typeof r.reportedValue.raw === 'number' && isFinite(r.reportedValue.raw));
    if (rows.length === 0) continue;
    const last = rows[rows.length - 1];
    latest[type] = { v: last.reportedValue.raw, asOfDate: last.asOfDate || null, ccy: last.currencyCode || null };
    if (rows.length > 1 && type.startsWith('annual')) prevAnnual[type] = rows[rows.length - 2].reportedValue.raw;
  }
  // The payload carries ONE currency tag per row, but the object it feeds needs
  // TWO: statements are reported in the company's reporting currency, market cap
  // is priced in the LISTING currency, and for plenty of listings those differ
  // (Naspers and Datatec trade in rand and report in dollars). Reading a single
  // "first currencyCode we met" - which is what this did - handed the statement
  // currency to the market cap, so a R570bn cap rendered as $600bn with no
  // conversion at all. Pick the reporting currency from a fixed, deterministic
  // list of STATEMENT types (never from a valuation row, and never from payload
  // order); the listing currency comes from the market, below.
  const STATEMENT_TYPES = [
    'trailingTotalRevenue', 'annualTotalRevenue',
    'trailingNetIncome', 'annualNetIncome',
    'trailingOperatingIncome', 'annualOperatingIncome',
    'trailingFreeCashFlow', 'annualFreeCashFlow',
    'trailingOperatingCashFlow', 'annualOperatingCashFlow',
    'trailingEBITDA', 'annualEBITDA',
    'trailingNormalizedEBITDA', 'annualNormalizedEBITDA',
    'annualStockholdersEquity', 'annualTotalDebt',
    'annualCurrentAssets', 'annualCurrentLiabilities',
    'trailingDilutedEPS', 'annualDilutedEPS'
  ];
  let currency = null;
  for (const t of STATEMENT_TYPES) {
    if (latest[t] && latest[t].ccy) { currency = latest[t].ccy; break; }
  }
  const L = (...types) => {
    for (const t of types) if (latest[t]) return latest[t].v;
    return null;
  };
  const growth = (type) => {
    const cur = latest[type] ? latest[type].v : null;
    const prev = prevAnnual[type];
    // Growth is meaningless off a non-positive base (sign flips) — skip it.
    if (cur == null || prev == null || !(prev > 0)) return null;
    return (cur / prev - 1) * 100;
  };
  const revenue = L('trailingTotalRevenue', 'annualTotalRevenue');
  const netIncome = L('trailingNetIncome', 'annualNetIncome');
  const equity = L('annualStockholdersEquity');
  const totalDebt = L('annualTotalDebt');
  const curAssets = L('annualCurrentAssets');
  const curLiabs = L('annualCurrentLiabilities');
  const asOfMs = (type) => {
    const d = latest[type] && latest[type].asOfDate ? Date.parse(latest[type].asOfDate) : NaN;
    return isFinite(d) ? d : null;
  };
  // A margin must divide like by like. Yahoo often answers with a TTM numerator
  // but no TTM revenue, and the old code then divided trailing net income by the
  // latest FISCAL-YEAR revenue - a silently wrong ratio (a growing company reads
  // too profitable, a shrinking one too thin). Take the basis where BOTH sides
  // exist: trailing first, then annual, else nothing.
  const margin = (trailingType, annualType) => {
    const tn = L(trailingType), tr = L('trailingTotalRevenue');
    if (tn != null && tr > 0) return tn / tr * 100;
    const an = L(annualType), ar = L('annualTotalRevenue');
    if (an != null && ar > 0) return an / ar * 100;
    return null;
  };
  const mc = (MARKET_CURRENCY[market] || MARKET_CURRENCY.US);
  const result = {
    marketCap: L('trailingMarketCap', 'quarterlyMarketCap'),
    peTrailing: L('trailingPeRatio', 'quarterlyPeRatio'),
    peForward: L('trailingForwardPeRatio', 'quarterlyForwardPeRatio'),
    pegRatio: L('trailingPegRatio', 'quarterlyPegRatio'),
    priceToBook: L('trailingPbRatio', 'quarterlyPbRatio'),
    bookValue: null,
    priceToSales: L('trailingPsRatio', 'quarterlyPsRatio'),
    eps: L('trailingDilutedEPS', 'annualDilutedEPS'),
    epsForward: null,
    beta: null,
    dividendYield: null,
    payoutRatio: null,
    profitMargin: margin('trailingNetIncome', 'annualNetIncome'),
    operatingMargin: margin('trailingOperatingIncome', 'annualOperatingIncome'),
    revenueGrowth: growth('annualTotalRevenue'),
    earningsGrowth: growth('annualNetIncome'),
    roe: (netIncome != null && equity > 0) ? netIncome / equity * 100 : null,
    roa: null,
    // Match Yahoo quoteSummary's convention: D/E reported as a percent.
    debtToEquity: (totalDebt != null && equity > 0) ? totalDebt / equity * 100 : null,
    currentRatio: (curAssets != null && curLiabs > 0) ? curAssets / curLiabs : null,
    totalCash: null,
    totalDebt: totalDebt,
    freeCashflow: L('trailingFreeCashFlow', 'annualFreeCashFlow'),
    operatingCashflow: L('trailingOperatingCashFlow', 'annualOperatingCashFlow'),
    revenue: revenue,
    ebitda: L('trailingEBITDA', 'trailingNormalizedEBITDA', 'annualEBITDA', 'annualNormalizedEBITDA'),
    // The period the TTM figures close on - a REPORTED period end, taken from a
    // statement row. quarterlyMarketCap's asOfDate (what this used to read) is a
    // valuation snapshot date, so the card captioned its P/E "Q ended <date>"
    // with a date the company never reported on.
    mostRecentQuarter: asOfMs('trailingNetIncome') || asOfMs('trailingTotalRevenue') || asOfMs('trailingDilutedEPS'),
    lastFiscalYearEnd: asOfMs('annualTotalRevenue') || asOfMs('annualNetIncome'),
    targetMean: null, targetHigh: null, targetLow: null,
    recommendation: null, analystCount: null,
    volume: null, avgVolume: null,
    yearHigh: null, yearLow: null,
    fiftyDayAvg: null, twoHundredDayAvg: null,
    earningsDate: null, earningsDateEnd: null,
    epsEst: null, revEst: null, dividendDate: null,
    sector: null, industry: null, employees: null,
    // Statement/valuation figures arrive in natural units (never pence/cents),
    // so the divisor is always 1. `currency` denominates the STATEMENT figures
    // (revenue, EBITDA, cash flow, EPS, debt) and comes from the payload's
    // statement rows; `marketCapCurrency` denominates the market cap and comes
    // from the MARKET, because a market cap is price x shares and is therefore
    // always quoted in the currency the share trades in - in major units, never
    // pence/cents (a R570bn cap is 570e9, not 57e12). The payload's own tag is
    // deliberately not trusted here: Yahoo returns rand-denominated caps on
    // USD-tagged payloads for JSE names that report in dollars.
    currency: currency || mc.code,
    marketCapCurrency: mc.code,
    divisor: 1,
    fetchedAt: Date.now(),
    source: 'yahoo-ts'
  };
  // Require a few real metrics to count as a hit — bookkeeping fields
  // (divisor, fetchedAt) and the period timestamps don't count.
  const skip = new Set(['divisor', 'fetchedAt', 'mostRecentQuarter', 'lastFiscalYearEnd']);
  const filled = Object.keys(result).filter(k => !skip.has(k) && typeof result[k] === 'number' && isFinite(result[k])).length;
  return filled >= 3 ? result : null;
}

// Fields carrying an ABSOLUTE money amount, split by which of a fundamentals
// object's two currencies denominates them. Everything not listed is a ratio, a
// percentage, a count, a date or a label - unitless, so it merges freely.
const FUND_STATEMENT_MONEY = new Set([
  'revenue', 'ebitda', 'freeCashflow', 'operatingCashflow', 'totalCash',
  'totalDebt', 'eps', 'epsForward', 'epsEst', 'revEst', 'bookValue', 'dividendRate'
]);
const FUND_CAP_MONEY = new Set(['marketCap']);
// Merge partial fundamentals from several sources (priority order: earlier
// wins per field, later sources only fill gaps). Sources cover different
// fields — stockanalysis has analyst/earnings data, the Yahoo timeseries has
// statement-derived ratios — so a merge beats first-hit-wins. Money fields are
// the exception: each source states its own reporting currency, so filling a
// gap across a currency boundary would pair (say) dollar revenue with a
// rand-tagged object and no downstream reader could tell. Those fields only
// cross when the currencies agree; an absent tag on either side counts as
// agreement (analyst-only parts carry no currency and no money).
// Returns null when nothing usable was fetched.
function mergeFundamentals(parts) {
  const real = (parts || []).filter(p => p && typeof p === 'object');
  if (real.length === 0) return null;
  if (real.length === 1) return real[0];
  // Resolve both currencies FIRST (earliest non-empty wins, the same priority
  // rule as every other field) so the compatibility test never depends on the
  // order keys happen to sit in inside a part.
  const firstCcy = (key) => { for (const p of real) { if (p[key]) return p[key]; } return null; };
  const statementCcy = firstCcy('currency');
  const capCcy = firstCcy('marketCapCurrency');
  const out = Object.assign({}, real[0]);
  for (let i = 1; i < real.length; i++) {
    const part = real[i];
    for (const k of Object.keys(part)) {
      const v = part[k];
      if (v == null) continue;
      if (!(out[k] == null || out[k] === '')) continue;
      if (FUND_STATEMENT_MONEY.has(k) && part.currency && statementCcy && part.currency !== statementCcy) continue;
      if (FUND_CAP_MONEY.has(k) && part.marketCapCurrency && capCcy && part.marketCapCurrency !== capCcy) continue;
      out[k] = v;
    }
  }
  if (statementCcy) out.currency = statementCcy;
  if (capCcy) out.marketCapCurrency = capCcy;
  out.source = real.map(p => p.source).filter(Boolean).join('+');
  return out;
}

// Yahoo currency code -> its 3-letter major-unit base ("ZAc"/"ZAX" -> ZAR,
// "GBp"/"GBX" -> GBP), falling back to the market's own currency. This is the
// unit a figure is DISPLAYED in; centDivisor owns the numeric scaling.
function baseCurrencyCode(code, market) {
  const c = (code || '').toUpperCase();
  if (c.startsWith('ZA')) return 'ZAR';
  if (c.startsWith('GB')) return 'GBP';
  if (c.startsWith('AU')) return 'AUD';
  if (c.startsWith('EU') || c === 'EUR') return 'EUR';
  if (c === 'USD' || c === 'USC') return 'USD';
  if (c.length === 3) return c;
  return (MARKET_CURRENCY[market] && MARKET_CURRENCY[market].code) || 'USD';
}
// Resolve the two currencies a fundamentals object mixes, and value its market
// cap. Pure, so no view has to do FX arithmetic inline:
//   statementCcy - what revenue / EBITDA / cash flow / EPS are denominated in
//   capCcy       - what the market cap is denominated in (the LISTING currency)
//   capNative    - the market cap as reported, in capCcy
//   capUsd       - that cap in USD, or null when no rate is available
// `rates` is the app's FX map (source units per 1 USD, USD === 1). An object
// cached before `marketCapCurrency` existed falls back to the market's own
// currency, which is exactly what that field always holds - so entries already
// sitting in the in-memory TTL cache render correctly too.
function fundamentalsMoney(f, market, rates) {
  const statementCcy = baseCurrencyCode(f && f.currency, market);
  const capCcy = baseCurrencyCode((f && f.marketCapCurrency) || null, market);
  const raw = f && f.marketCap;
  const capNative = (typeof raw === 'number' && isFinite(raw) && raw > 0) ? raw : null;
  let capUsd = null;
  if (capNative != null) {
    if (capCcy === 'USD') capUsd = capNative;
    else {
      const rate = rates && rates[capCcy];
      if (typeof rate === 'number' && isFinite(rate) && rate > 0) capUsd = capNative / rate;
    }
  }
  return { statementCcy, capCcy, capNative, capUsd };
}
// Trailing-twelve-month dividends out of a Yahoo chart payload fetched with
// `events=div` - the keyless way to get a dividend yield now that the
// timeseries carries none and stockanalysis's API is dead (GAPS #18).
//
// The yield is TTM dividends / price taken straight off the payload's own
// numbers, so both sides are in the listing's quoted units and the pence/cents
// divisor CANCELS - the one figure here that cannot be broken by the unit trap.
// The per-share rate is money on the card, so that one does get the divisor.
// `meta.regularMarketPrice` is the last traded price (see the day-move trap),
// which for a yield denominator is immaterial - a few basis points at most.
// `now` is injectable so the TTM window is testable.
function parseDividendEvents(json, market, now) {
  const r = json?.chart?.result?.[0];
  const meta = r?.meta;
  const divs = r?.events?.dividends;
  if (!meta || !divs || typeof divs !== 'object') return null;
  const nowMs = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  const fromSec = (nowMs - 365 * 24 * 3600 * 1000) / 1000;
  const toSec = nowMs / 1000;
  let sum = 0, count = 0, lastSec = null;
  for (const k of Object.keys(divs)) {
    const d = divs[k];
    if (!d) continue;
    const amt = (typeof d.amount === 'number' && isFinite(d.amount)) ? d.amount : null;
    const at = (typeof d.date === 'number' && isFinite(d.date)) ? d.date : Number(k);
    if (amt == null || amt <= 0 || !isFinite(at)) continue;
    if (at < fromSec || at > toSec) continue;
    sum += amt;
    count++;
    if (lastSec == null || at > lastSec) lastSec = at;
  }
  if (count === 0 || !(sum > 0)) return null;
  const px = meta.regularMarketPrice;
  const price = (typeof px === 'number' && isFinite(px) && px > 0) ? px : null;
  const divisor = centDivisor(market, meta.currency || '');
  return {
    dividendYield: price != null ? sum / price * 100 : null,
    dividendRate: sum / divisor,
    lastDividendDate: lastSec != null ? lastSec * 1000 : null,
    dividendCount: count,
    fetchedAt: Date.now(),
    source: 'yahoo-div'
  };
}

// ─── stockanalysis.com forecast page-data parser ────────────────────────────
// Parses the SvelteKit __data.json behind stockanalysis.com's public
// /forecast/ pages into a PARTIAL fundamentals object carrying only the
// analyst-consensus fields (the /api/symbol tree that used to supply them went
// 404-dead on 2026-07-12). Payload nodes use SvelteKit's "devalue" flat-array
// encoding: a node's `data` is a flat array where objects are key→index maps
// into that same array, arrays are lists of indices, and -1 means undefined.
// Targets arrive in the listing's minor units (ZAc rand-cents, GBX pence) and
// are scaled to natural units here — centDivisor owns that mapping — so they
// match quote prices and the card's upside math. Pure: unit-tested in
// backend/test/sa-forecast-parse.test.mjs.
function devalueNode(data, i, seen) {
  if (i == null || i === -1 || typeof i !== 'number') return undefined;
  const v = data[i];
  if (v === null || typeof v !== 'object') return v;
  if (!seen) seen = new Set();
  if (seen.has(i)) return undefined; // cycle guard — malformed payload
  seen.add(i);
  let out;
  if (Array.isArray(v)) out = v.map(x => devalueNode(data, x, seen));
  else {
    out = {};
    for (const k of Object.keys(v)) out[k] = devalueNode(data, v[k], seen);
  }
  seen.delete(i);
  return out;
}
function parseSAForecast(json, market) {
  const nodes = json && Array.isArray(json.nodes) ? json.nodes : null;
  if (!nodes) return null;
  let root = null;
  for (const n of nodes) {
    if (!n || n.type !== 'data' || !Array.isArray(n.data) || n.data.length === 0) continue;
    let r;
    try { r = devalueNode(n.data, 0); } catch (_e) { continue; }
    if (r && typeof r === 'object' && (r.targets || r.priceTargets)) { root = r; break; }
  }
  if (!root) return null;
  const num = (x) => (typeof x === 'number' && isFinite(x) && x > 0) ? x : null;
  // Prefer the curated target set (`targets`) — it's what the public forecast
  // page headlines and the only one with an `updated` date — falling back to
  // the S&P Global pool (`priceTargets`, source "spg"), which covers listings
  // the curated set skips (e.g. JSE names).
  const cur = root.targets && typeof root.targets === 'object' ? root.targets : null;
  const spg = root.priceTargets && typeof root.priceTargets === 'object' ? root.priceTargets : null;
  let set = null;
  if (cur && num(cur.count) && num(cur.average)) {
    set = { mean: num(cur.average), high: num(cur.high), low: num(cur.low), count: num(cur.count), currency: cur.currency, updated: cur.updated };
  } else if (spg && num(spg.numPriceTargets) && num(spg.avg)) {
    set = { mean: num(spg.avg), high: num(spg.high), low: num(spg.low), count: num(spg.numPriceTargets), currency: spg.currency, updated: null };
  }
  if (!set) return null;
  const div = centDivisor(market, set.currency || '') || 1;
  const scale = (n) => (n != null ? n / div : null);
  // Ratings consensus ("Buy", "Strong Buy", …) → the recommendationKey
  // vocabulary the card already styles (rec-buy, rec-strong_buy, …). A pool of
  // zero analysts is noise, not a consensus.
  let recommendation = null;
  const cr = root.currentRatings;
  if (cr && typeof cr === 'object' && num(cr.count) && typeof cr.consensus === 'string') {
    const key = cr.consensus.trim().toLowerCase().replace(/\s+/g, '_');
    if (['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'].indexOf(key) >= 0) recommendation = key;
  }
  const updatedMs = set.updated ? Date.parse(set.updated) : NaN;
  return {
    targetMean: scale(set.mean),
    targetHigh: scale(set.high),
    targetLow: scale(set.low),
    // What those targets are denominated in, once scaled to major units. The
    // S&P Global pool (`priceTargets`) quotes some non-US listings in dollars,
    // and a USD target measured against a rand price reads as a ~-95% "upside",
    // so the card has to know rather than assume the listing's currency.
    targetCurrency: baseCurrencyCode(set.currency || '', market),
    analystCount: set.count,
    recommendation,
    targetUpdated: isFinite(updatedMs) ? updatedMs : null,
    targetSource: 'stockanalysis.com',
    fetchedAt: Date.now(),
    source: 'sa-forecast'
  };
}

// Next-earnings date from stockanalysis.com's OVERVIEW page-data (same
// SvelteKit __data.json transport as the forecast parser above; the dead
// /api/symbol tree used to serve this as `data.earningsDate`). The payload
// shape isn't pinned by a contract, so this walks every data node and
// deep-searches for the site's own key vocabulary rather than assuming a
// path; anything unrecognised degrades to null, never a throw. Accepts a
// parseable date string or an epoch in seconds/ms; returns epoch ms or null.
function saEpochMs(v) {
  if (typeof v === 'number' && isFinite(v)) {
    if (v > 1e12) return v;                    // already ms
    if (v > 1e9) return v * 1000;              // seconds
    return null;
  }
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    return isNaN(ms) ? null : ms;
  }
  return null;
}
function findEarningsDateDeep(node, depth) {
  if (node == null || typeof node !== 'object' || depth > 6) return null;
  if (!Array.isArray(node)) {
    for (const k of Object.keys(node)) {
      if (/^(next)?[_ ]?earnings[_ ]?date$/i.test(k)) {
        const ms = saEpochMs(node[k]);
        if (ms != null) return ms;
      }
    }
  }
  const vals = Array.isArray(node) ? node : Object.values(node);
  for (const v of vals) {
    const ms = findEarningsDateDeep(v, depth + 1);
    if (ms != null) return ms;
  }
  return null;
}
function parseSAOverviewEarnings(json) {
  const nodes = json && Array.isArray(json.nodes) ? json.nodes : null;
  if (!nodes) return null;
  for (const n of nodes) {
    if (!n || n.type !== 'data' || !Array.isArray(n.data) || n.data.length === 0) continue;
    let r;
    try { r = devalueNode(n.data, 0); } catch (_e) { continue; }
    const ms = findEarningsDateDeep(r, 0);
    if (ms != null) return ms;
  }
  return null;
}

// ─── Market rotation math (Rotation tab) ────────────────────────────────────
// Pure aggregation/classification for the sector-rotation view: given the same
// constituent rows the heatmap paints ({ticker, sector, m: static cap in
// local-currency billions, changePct}), estimate where money moved today and
// whether the day is a net inflow/outflow or an internal rotation. "Flow" here
// is a price-based proxy (index weight x day move = market-cap delta), NOT
// observed traded volume - the UI labels it as an estimate. Everything below is
// deterministic given its inputs (no Date.now(), no globals) so the whole
// pipeline is node-testable (backend/test/rotation-core.test.mjs).

// Classification thresholds, in percentage points of day change. Exported so
// the tests pin the boundaries and tuning stays a one-line change.
const ROTATION_THRESHOLDS = {
  NET: 0.25,        // |cap-weighted market move| >= NET -> net money in/out
  FLAT: 0.15,       // |market move| < FLAT counts toward a "quiet" session
  DISP: 0.50,       // cap-weighted sector dispersion >= DISP -> rotation candidate
  SIDE: 0.30,       // a sector must move +/-SIDE (with matching deltaCap sign) to anchor a rotation
  BREADTH_HI: 0.60, // net-down day with breadth above this reads "mixed", not outflow
  BREADTH_LO: 0.40, // net-up day with breadth below this reads "mixed" (narrow rally)
  QUIET_DISP: 0.35  // dispersion below this (with a flat market) -> "quiet"
};

// rows: [{ticker, sector, m, changePct|null}] -> per-sector + whole-market
// aggregates. Rows without a finite changePct count toward count/weight (the
// universe size) but are excluded from every price-derived stat (wPct, deltaCap,
// breadth, top/bottom): a missing quote is "unknown", not "unchanged".
// deltaCap = sum(m_i * changePct_i / 100) = estimated market-cap delta in the
// index's local-currency billions; market.deltaCap === sum(sector.deltaCap).
function aggregateSectorSnapshot(rows) {
  const bySector = new Map();
  for (const r of rows || []) {
    if (!r || !r.sector) continue;
    let s = bySector.get(r.sector);
    if (!s) {
      s = { sector: r.sector, count: 0, quoted: 0, weight: 0, quotedWeight: 0, wSum: 0, deltaCap: 0, adv: 0, dec: 0, flat: 0, top: null, bottom: null };
      bySector.set(r.sector, s);
    }
    const m = isFinite(r.m) && r.m > 0 ? r.m : 0;
    s.count++; s.weight += m;
    const pct = r.changePct;
    if (pct == null || !isFinite(pct)) continue;
    s.quoted++; s.quotedWeight += m;
    s.wSum += m * pct;
    s.deltaCap += m * pct / 100;
    if (pct > 0) s.adv++; else if (pct < 0) s.dec++; else s.flat++;
    if (!s.top || pct > s.top.changePct) s.top = { ticker: r.ticker, changePct: pct };
    if (!s.bottom || pct < s.bottom.changePct) s.bottom = { ticker: r.ticker, changePct: pct };
  }
  const sectors = [...bySector.values()].map(s => ({
    sector: s.sector, count: s.count, quoted: s.quoted, weight: s.weight, quotedWeight: s.quotedWeight,
    wPct: s.quotedWeight > 0 ? s.wSum / s.quotedWeight : null,
    deltaCap: s.deltaCap, adv: s.adv, dec: s.dec, flat: s.flat, top: s.top, bottom: s.bottom
  }));
  sectors.sort((a, b) => (b.deltaCap - a.deltaCap) || a.sector.localeCompare(b.sector));
  const market = { count: 0, quoted: 0, totalWeight: 0, quotedWeight: 0, deltaCap: 0, adv: 0, dec: 0, flat: 0 };
  let mWSum = 0;
  for (const s of sectors) {
    market.count += s.count; market.quoted += s.quoted;
    market.totalWeight += s.weight; market.quotedWeight += s.quotedWeight;
    market.deltaCap += s.deltaCap; market.adv += s.adv; market.dec += s.dec; market.flat += s.flat;
    if (s.wPct != null) mWSum += s.wPct * s.quotedWeight;
  }
  market.wPct = market.quotedWeight > 0 ? mWSum / market.quotedWeight : null;
  return { sectors, market };
}

// snapshot -> plain-language classification of the session. Deterministic;
// thresholds injectable for tests. "Rotating" requires BOTH real cross-sector
// dispersion AND a two-sided move (some sector up >= SIDE gaining cap while
// another is down >= SIDE losing cap) - dispersion alone can just be one
// runaway sector, which is a narrow move, not a rotation.
function classifyRotation(snapshot, thresholds) {
  const T = thresholds || ROTATION_THRESHOLDS;
  const sectors = (snapshot && snapshot.sectors) || [];
  const market = (snapshot && snapshot.market) || {};
  const marketPct = market.wPct != null ? market.wPct : 0;
  const dirTotal = (market.adv || 0) + (market.dec || 0);
  const breadthPct = dirTotal === 0 ? 0.5 : market.adv / dirTotal;
  let varSum = 0, wTot = 0;
  for (const s of sectors) {
    if (s.wPct == null || !(s.quotedWeight > 0)) continue;
    varSum += s.quotedWeight * Math.pow(s.wPct - marketPct, 2);
    wTot += s.quotedWeight;
  }
  const dispersion = wTot > 0 ? Math.sqrt(varSum / wTot) : 0;
  const net = marketPct >= T.NET ? 'in' : marketPct <= -T.NET ? 'out' : 'flat';
  const hasUpSide = sectors.some(s => s.wPct != null && s.wPct >= T.SIDE && s.deltaCap > 0);
  const hasDownSide = sectors.some(s => s.wPct != null && s.wPct <= -T.SIDE && s.deltaCap < 0);
  const rotating = dispersion >= T.DISP && hasUpSide && hasDownSide;
  let verdict;
  if (net === 'flat' && !rotating && Math.abs(marketPct) < T.FLAT && dispersion < T.QUIET_DISP) verdict = 'quiet';
  else if (net === 'in' && rotating) verdict = 'inflow-rotation';
  else if (net === 'out' && rotating) verdict = 'outflow-rotation';
  else if (rotating) verdict = 'rotation';
  else if (net === 'in') verdict = breadthPct >= T.BREADTH_LO ? 'inflow' : 'mixed';
  else if (net === 'out') verdict = breadthPct <= T.BREADTH_HI ? 'outflow' : 'mixed';
  else verdict = 'mixed';
  const confidence = (market.quoted >= 0.6 * market.count && market.quotedWeight >= 0.6 * market.totalWeight) ? 'high' : 'low';
  const inflows = sectors.filter(s => s.deltaCap > 0).slice().sort((a, b) => b.deltaCap - a.deltaCap);
  const outflows = sectors.filter(s => s.deltaCap < 0).slice().sort((a, b) => Math.abs(b.deltaCap) - Math.abs(a.deltaCap));
  return { verdict, net, rotating, confidence, marketPct, breadthPct, dispersion, inflows, outflows };
}

// Proportionally allocate today's sector outflow pool onto the inflow pool for
// the rotation ribbons: flow(out i -> in j) = matched * share_i * share_j. This
// is a display allocation (who lost cap vs who gained it), not observed order
// flow. Conservation is exact by construction - sum(flows.amount) === matched
// (= min(totalIn, totalOut)) - and the view, not this function, drops sub-2%
// ribbons so persisted/derived totals never drift from the math.
function pairFlows(sectors) {
  const ins = (sectors || []).filter(s => s.deltaCap > 0).slice().sort((a, b) => b.deltaCap - a.deltaCap);
  const outs = (sectors || []).filter(s => s.deltaCap < 0).slice().sort((a, b) => Math.abs(b.deltaCap) - Math.abs(a.deltaCap));
  const totalIn = ins.reduce((t, s) => t + s.deltaCap, 0);
  const totalOut = outs.reduce((t, s) => t + Math.abs(s.deltaCap), 0);
  const matched = Math.min(totalIn, totalOut);
  const flows = [];
  if (matched > 0) {
    for (const o of outs) {
      for (const i of ins) {
        flows.push({ from: o.sector, to: i.sector, amount: matched * (Math.abs(o.deltaCap) / totalOut) * (i.deltaCap / totalIn) });
      }
    }
  }
  return { totalIn, totalOut, matched, net: totalIn - totalOut, flows };
}

// One intraday fetch leg per sector. US indices with a sector->ETF map get
// 'etf' mode - one SPDR per sector actually present in THIS index (nasdaq100
// has 7 sectors, not 11), deduped across alias keys (Financials/Financial
// Services -> XLF). Everything else gets 'stocks' mode: the top-N constituents
// by static cap, cap-weighted into a sector line later. Leg weight is the FULL
// sector cap sum (not just top-N) so the benchmark combine matches index
// composition. sectorEtf is passed in (PBContent.SECTOR_ETF in the app) so
// pb-core stays dependency-free.
function buildRotationFetchPlan(def, opts) {
  const o = opts || {};
  const topN = o.topN || 3;
  const sectorEtf = o.sectorEtf || null;
  const useEtf = !!(def && def.market === 'US' && sectorEtf);
  const bySector = new Map();
  for (const c of (def && def.constituents) || []) {
    if (!c || !c.s) continue;
    if (!bySector.has(c.s)) bySector.set(c.s, []);
    bySector.get(c.s).push(c);
  }
  const legs = [];
  const seenEtf = new Set();
  for (const [sector, cons] of bySector) {
    const weight = cons.reduce((t, c) => t + (isFinite(c.m) ? c.m : 0), 0);
    if (useEtf) {
      const meta = sectorEtf[sector];
      if (!meta || !meta.etf) continue;    // unmapped sector: no timeline leg (snapshot still covers it)
      if (seenEtf.has(meta.etf)) continue; // alias keys collapse to one ETF leg
      seenEtf.add(meta.etf);
      legs.push({ key: sector, weight, symbols: [{ ticker: meta.etf, market: 'US', w: 1 }] });
    } else {
      const top = cons.slice().sort((a, b) => (b.m || 0) - (a.m || 0)).slice(0, topN);
      legs.push({ key: sector, weight, symbols: top.map(c => ({ ticker: c.t, market: def.market, w: isFinite(c.m) ? c.m : 0 })) });
    }
  }
  legs.sort((a, b) => b.weight - a.weight);
  return { mode: useEtf ? 'etf' : 'stocks', legs };
}

// Align several intraday bar series onto one timestamp grid and express each as
// cumulative % from its base: prevClose when known (so the line's last value
// matches the quote's day-% semantics), else the first regular-session bar,
// else the first bar. Bars a series is missing forward-fill from its last
// print; a series is null before its first bar (late open / halt) rather than
// pretending it traded. benchmark = weight-renormalized mean of whichever
// series are non-null at each point, so names dropping in and out never step
// the market line.
function buildIntradaySeries(inputs, opts) {
  const o = opts || {};
  let ts;
  if (Array.isArray(o.grid)) {
    ts = o.grid;
  } else {
    const tsSet = new Set();
    for (const inp of inputs || []) for (const p of (inp && inp.points) || []) if (p && isFinite(p.t)) tsSet.add(p.t);
    ts = [...tsSet].sort((a, b) => a - b);
  }
  const regularStart = isFinite(o.regularStart) ? o.regularStart : null;
  const regularEnd = isFinite(o.regularEnd) ? o.regularEnd : null;
  const sessionAt = ts.map(t => (regularStart != null && t < regularStart) ? 'pre' : (regularEnd != null && t > regularEnd) ? 'post' : 'regular');
  const series = [];
  for (const inp of inputs || []) {
    const pts = ((inp && inp.points) || []).filter(p => p && isFinite(p.t) && isFinite(p.p));
    let base = (inp && isFinite(inp.prevClose) && inp.prevClose > 0) ? inp.prevClose : null;
    if (base == null && regularStart != null) { const fr = pts.find(p => p.t >= regularStart); if (fr) base = fr.p; }
    if (base == null && pts.length) base = pts[0].p;
    const cum = new Array(ts.length).fill(null);
    let i = 0, last = null;
    for (let g = 0; g < ts.length; g++) {
      while (i < pts.length && pts[i].t <= ts[g]) { last = pts[i].p; i++; }
      cum[g] = (last != null && base != null && base > 0) ? (last / base - 1) * 100 : null;
    }
    series.push({ key: inp.key, weight: isFinite(inp && inp.weight) ? inp.weight : 0, cum });
  }
  const benchmark = ts.map((_, g) => {
    let ws = 0, vs = 0;
    for (const s of series) {
      const v = s.cum[g];
      if (v == null || !(s.weight > 0)) continue;
      ws += s.weight; vs += s.weight * v;
    }
    return ws > 0 ? vs / ws : null;
  });
  return { ts, sessionAt, series, benchmark, regularStart, regularEnd };
}

// plan (buildRotationFetchPlan) + fetched bars (keyed by priceKey) -> one
// sector line per leg plus the market benchmark, all on one shared grid.
// 'etf' legs have a single symbol so the sector line IS the ETF's cum series;
// 'stocks' legs cap-weight their constituents. Legs whose symbols all failed
// are omitted (the benchmark renormalizes over what's left). activity = rough
// regular-session dollar-volume share per sector, null-safe because many non-US
// 5m feeds omit volume - the view hides the bar when null.
function combineSectorSeries(plan, barsBySymbol) {
  const legs = (plan && plan.legs) || [];
  const bars = barsBySymbol || {};
  let regularStart = null, regularEnd = null;
  const tsSet = new Set();
  for (const leg of legs) {
    for (const sym of leg.symbols) {
      const b = bars[priceKey(sym.market, sym.ticker)];
      if (!b || !Array.isArray(b.points)) continue;
      if (regularStart == null && isFinite(b.regularStart)) regularStart = b.regularStart;
      if (regularEnd == null && isFinite(b.regularEnd)) regularEnd = b.regularEnd;
      for (const p of b.points) if (p && isFinite(p.t)) tsSet.add(p.t);
    }
  }
  const ts = [...tsSet].sort((a, b) => a - b);
  const sectorLines = [];
  const activity = [];
  for (const leg of legs) {
    const inputs = [];
    let dollarVol = 0, sawVol = false;
    for (const sym of leg.symbols) {
      const b = bars[priceKey(sym.market, sym.ticker)];
      if (!b || !Array.isArray(b.points) || b.points.length === 0) continue;
      inputs.push({ key: sym.ticker, weight: sym.w, prevClose: b.prevClose, points: b.points });
      for (const p of b.points) {
        if (!p || p.v == null || !isFinite(p.v) || !isFinite(p.p)) continue;
        if (regularStart != null && p.t < regularStart) continue;
        if (regularEnd != null && p.t > regularEnd) continue;
        dollarVol += p.v * p.p; sawVol = true;
      }
    }
    if (inputs.length === 0) { activity.push({ key: leg.key, dollarVol: null, share: null }); continue; }
    const built = buildIntradaySeries(inputs, { grid: ts, regularStart, regularEnd });
    sectorLines.push({ key: leg.key, weight: leg.weight, cum: built.benchmark });
    activity.push({ key: leg.key, dollarVol: sawVol ? dollarVol : null, share: null });
  }
  const totalVol = activity.reduce((t, a) => t + (a.dollarVol != null ? a.dollarVol : 0), 0);
  for (const a of activity) a.share = (a.dollarVol != null && totalVol > 0) ? a.dollarVol / totalVol : null;
  const sessionAt = ts.map(t => (regularStart != null && t < regularStart) ? 'pre' : (regularEnd != null && t > regularEnd) ? 'post' : 'regular');
  const benchmark = ts.map((_, g) => {
    let ws = 0, vs = 0;
    for (const s of sectorLines) {
      const v = s.cum[g];
      if (v == null || !(s.weight > 0)) continue;
      ws += s.weight; vs += s.weight * v;
    }
    return ws > 0 ? vs / ws : null;
  });
  return { ts, sessionAt, series: sectorLines, benchmark, regularStart, regularEnd, activity };
}

// Thin a combined-series object for localStorage persistence (the display path
// keeps the full-resolution object in memory): keep at most maxPoints grid
// points, ALWAYS including the last one (walk back from the end so the newest
// print survives), and round values to 2dp. ~48 points x 11 sectors x 9
// exchanges stays well under 100KB total.
function downsampleRotationSeries(built, maxPoints) {
  if (!built || !Array.isArray(built.ts)) return built;
  const cap = maxPoints || 48;
  const n = built.ts.length;
  const step = Math.max(1, Math.ceil(n / cap));
  const idx = [];
  for (let i = n - 1; i >= 0; i -= step) idx.push(i);
  idx.reverse();
  const r2 = v => v == null ? null : Math.round(v * 100) / 100;
  return {
    ts: idx.map(i => built.ts[i]),
    sessionAt: Array.isArray(built.sessionAt) ? idx.map(i => built.sessionAt[i]) : built.sessionAt,
    series: (built.series || []).map(s => ({ key: s.key, weight: s.weight, cum: idx.map(i => r2(s.cum[i])) })),
    benchmark: Array.isArray(built.benchmark) ? idx.map(i => r2(built.benchmark[i])) : built.benchmark,
    regularStart: built.regularStart, regularEnd: built.regularEnd,
    activity: built.activity
  };
}

// The data-driven sentence under the verdict title (the static titles live in
// PBContent.ROTATION_COPY so copy edits never touch math). ASCII only.
function rotationSummary(classified) {
  if (!classified) return '';
  const c = classified;
  const pct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const names = arr => arr.slice(0, 2).map(s => s.sector).join(' and ');
  const secUp = c.inflows.length, secDown = c.outflows.length;
  if (c.rotating) {
    const outN = names(c.outflows), inN = names(c.inflows);
    const lead = outN && inN ? 'Out of ' + outN + ', into ' + inN + '.' : (outN ? 'Out of ' + outN + '.' : (inN ? 'Into ' + inN + '.' : ''));
    return (lead + ' Market net ' + pct(c.marketPct) + '.').trim();
  }
  if (c.verdict === 'inflow') return secUp + ' of ' + (secUp + secDown) + ' sectors gaining; breadth ' + Math.round(c.breadthPct * 100) + '%. Market ' + pct(c.marketPct) + '.';
  if (c.verdict === 'outflow') return secDown + ' of ' + (secUp + secDown) + ' sectors losing; breadth ' + Math.round(c.breadthPct * 100) + '%. Market ' + pct(c.marketPct) + '.';
  if (c.verdict === 'quiet') return 'Little net movement or sector dispersion. Market ' + pct(c.marketPct) + '.';
  return 'No clear direction; breadth ' + Math.round(c.breadthPct * 100) + '%, dispersion ' + c.dispersion.toFixed(2) + 'pp. Market ' + pct(c.marketPct) + '.';
}

  const PBCore = {
    TRIGGER_COOLDOWN_MS,
    SESSIONS,
    marketOpen,
    anyMarketOpen,
    marketSession,
    tradedToday,
    quoteTradedToday,
    regularSessionStartedToday,
    fmtAgo,
    refreshChipState,
    priceKey,
    buildFetchPlan,
    evaluateAlerts,
    centDivisor,
    yahooSymbol,
    sameUnderlyingExchange,
    pLimit,
    MARKET_CURRENCY,
    convertCcy,
    contribInDisplay,
    marketCurrency,
    positionCostCcy,
    valuePositionInCostCcy,
    forwardFillPortfolio,
    resolvePositionUpdates,
    mergeCostBasis,
    buildDailyBars,
    marketDayKey,
    derivePrevClose,
    deriveDayMove,
    plausiblePriceMove,
    guardQuote,
    resolveTradingWindows,
    lastCloseInWindow,
    deriveIntradayExt,
    parseYahooQuote,
    parseDecimal,
    parseFundamentalsTimeseries,
    mergeFundamentals,
    baseCurrencyCode,
    fundamentalsMoney,
    parseDividendEvents,
    parseSAForecast,
    parseSAOverviewEarnings,
    ROTATION_THRESHOLDS,
    aggregateSectorSnapshot,
    classifyRotation,
    pairFlows,
    buildRotationFetchPlan,
    buildIntradaySeries,
    combineSectorSeries,
    downsampleRotationSeries,
    rotationSummary
  };

  // Dual export: CommonJS for the Worker bundler + Node tests; global for the
  // browser (loaded via <script src="./pb-core.js"> before app.js).
  if (typeof module !== 'undefined' && module.exports) module.exports = PBCore;
  if (typeof globalThis !== 'undefined') globalThis.PBCore = PBCore;
})();
