// ─── Playbook shared core ────────────────────────────────────────────────────
// The ONE source of truth for the two pieces of logic that used to be copy-pasted
// (and had drifted) between the client (app.js) and the push backend
// (backend/worker.js): market-hours and price-alert evaluation. An alert must
// behave identically whether it's evaluated in the foreground app or by the
// server while the app is closed — so both import this.
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
    US:   { tz: 'America/New_York',    open: 4 * 60,  close: 20 * 60 },     // incl. pre/post
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

  const PBCore = {
    TRIGGER_COOLDOWN_MS,
    SESSIONS,
    marketOpen,
    anyMarketOpen,
    evaluateAlerts
  };

  // Dual export: CommonJS for the Worker bundler + Node tests; global for the
  // browser (loaded via <script src="./pb-core.js"> before app.js).
  if (typeof module !== 'undefined' && module.exports) module.exports = PBCore;
  if (typeof globalThis !== 'undefined') globalThis.PBCore = PBCore;
})();
