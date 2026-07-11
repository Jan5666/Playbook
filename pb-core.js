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
  // Derive the live extended-hours (pre/post) quote from an intraday chart result.
  // Yahoo's chart `meta` no longer carries preMarketPrice/postMarketPrice and the
  // v7 quote endpoint that did is now blocked — so the only reliable source is the
  // intraday bars themselves (fetched with includePrePost). We classify "now"
  // against the day's trading periods and, when we're actually in pre- or
  // post-market, take the latest traded close in that session and measure it
  // against the regular close — exactly the figure Google shows as
  // "Pre-market" / "After hours". Returns null outside extended hours so the UI
  // shows nothing during the regular session or when the market is fully closed.
  function deriveIntradayExt(result, market, now = Date.now()) {
    const meta = result?.meta;
    const ctp = meta?.currentTradingPeriod;
    const ts = result?.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!meta || !ctp || !ctp.regular || !Array.isArray(ts) || !Array.isArray(closes)) return null;
    if (typeof meta.regularMarketPrice !== 'number') return null;
    const nowSec = now / 1000;
    let kind = null, sess = null;
    if (ctp.post && nowSec >= ctp.post.start && nowSec < ctp.post.end) { kind = 'post'; sess = ctp.post; }
    else if (ctp.pre && nowSec >= ctp.pre.start && nowSec < ctp.pre.end) { kind = 'pre'; sess = ctp.pre; }
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
    for (let i = ts.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (c == null || !isFinite(c)) continue;
      if (ts[i] < sess.start || ts[i] >= sess.end) continue;
      if (raw == null) raw = c;
      if (c !== meta.regularMarketPrice) moved = true;
      if (raw != null && moved) break;
    }
    if (raw == null) return null;
    // No genuine after-hours activity (every bar forward-filled at the close) →
    // nothing meaningful to show. We deliberately do NOT gate on the *size* of
    // the move: a stock trading flat (±0.01%) after hours is still real, live
    // information, and hiding small moves is exactly what made the readout appear
    // for some holdings (movers) but not others (steady names).
    if (!moved) return null;
    const currency = meta.currency || (MARKET_CURRENCY[market]?.code || 'USD');
    const divisor = centDivisor(market, currency);
    const extPrice = raw / divisor;
    const regularPrice = meta.regularMarketPrice / divisor;
    if (!(regularPrice > 0) || !(extPrice > 0)) return null;
    return {
      extPrice,
      extChange: extPrice - regularPrice,
      extChangePct: (extPrice - regularPrice) / regularPrice * 100,
      extKind: kind,
      marketState: kind === 'post' ? 'POST' : 'PRE'
    };
  }
  // Convert one Yahoo chart result into the app's normalized quote shape.
  // Returns null if the response shape is unusable so the caller can fall
  // through to the next proxy or data source.
  function parseYahooQuote(result, market) {
    const meta = result?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
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
    try {
      prevClose = derivePrevClose(buildDailyBars(result, divisor), price, prevClose, market);
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
      currency,
      marketState: meta.marketState || 'UNKNOWN',
      shortName: meta.shortName || meta.longName || null,
      longName: meta.longName || meta.shortName || null,
      // Upstream timestamp (in ms) of the most recent price tick. Callers use
      // this to detect stale data — fetchedAt only tracks when WE saw it, which
      // can drift far from the actual market clock when an upstream feed lags.
      regularMarketTime: typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : null,
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
  // latest[type] = { v, asOfDate }; prevAnnual[type] = value before latest
  // (for YoY growth on annual statement items).
  const latest = {};
  const prevAnnual = {};
  let currency = null;
  for (const entry of results) {
    const type = entry?.meta?.type?.[0];
    if (!type || !Array.isArray(entry[type])) continue;
    const rows = entry[type].filter(r => r && r.reportedValue && typeof r.reportedValue.raw === 'number' && isFinite(r.reportedValue.raw));
    if (rows.length === 0) continue;
    const last = rows[rows.length - 1];
    latest[type] = { v: last.reportedValue.raw, asOfDate: last.asOfDate || null };
    if (rows.length > 1 && type.startsWith('annual')) prevAnnual[type] = rows[rows.length - 2].reportedValue.raw;
    if (!currency && last.currencyCode) currency = last.currencyCode;
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
  const opIncome = L('trailingOperatingIncome', 'annualOperatingIncome');
  const equity = L('annualStockholdersEquity');
  const totalDebt = L('annualTotalDebt');
  const curAssets = L('annualCurrentAssets');
  const curLiabs = L('annualCurrentLiabilities');
  const asOfMs = (type) => {
    const d = latest[type] && latest[type].asOfDate ? Date.parse(latest[type].asOfDate) : NaN;
    return isFinite(d) ? d : null;
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
    profitMargin: (netIncome != null && revenue > 0) ? netIncome / revenue * 100 : null,
    operatingMargin: (opIncome != null && revenue > 0) ? opIncome / revenue * 100 : null,
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
    mostRecentQuarter: asOfMs('quarterlyMarketCap') || asOfMs('quarterlyPeRatio'),
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
    // so the divisor is always 1; currency comes from the payload when present.
    currency: currency || mc.code,
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

// Merge partial fundamentals from several sources (priority order: earlier
// wins per field, later sources only fill gaps). Sources cover different
// fields — stockanalysis has analyst/earnings data, the Yahoo timeseries has
// statement-derived ratios — so a merge beats first-hit-wins. All sources
// normalise money fields to natural units before this point, so mixing per
// field is safe. Returns null when nothing usable was fetched.
function mergeFundamentals(parts) {
  const real = (parts || []).filter(p => p && typeof p === 'object');
  if (real.length === 0) return null;
  if (real.length === 1) return real[0];
  const out = Object.assign({}, real[0]);
  for (let i = 1; i < real.length; i++) {
    for (const k of Object.keys(real[i])) {
      const v = real[i][k];
      if (v == null) continue;
      if (out[k] == null || out[k] === '') out[k] = v;
    }
  }
  out.source = real.map(p => p.source).filter(Boolean).join('+');
  return out;
}

  const PBCore = {
    TRIGGER_COOLDOWN_MS,
    SESSIONS,
    marketOpen,
    anyMarketOpen,
    marketSession,
    tradedToday,
    quoteTradedToday,
    fmtAgo,
    refreshChipState,
    priceKey,
    buildFetchPlan,
    evaluateAlerts,
    centDivisor,
    yahooSymbol,
    pLimit,
    MARKET_CURRENCY,
    convertCcy,
    contribInDisplay,
    marketCurrency,
    positionCostCcy,
    valuePositionInCostCcy,
    resolvePositionUpdates,
    mergeCostBasis,
    buildDailyBars,
    marketDayKey,
    derivePrevClose,
    deriveIntradayExt,
    parseYahooQuote,
    parseDecimal,
    parseFundamentalsTimeseries,
    mergeFundamentals
  };

  // Dual export: CommonJS for the Worker bundler + Node tests; global for the
  // browser (loaded via <script src="./pb-core.js"> before app.js).
  if (typeof module !== 'undefined' && module.exports) module.exports = PBCore;
  if (typeof globalThis !== 'undefined') globalThis.PBCore = PBCore;
})();
