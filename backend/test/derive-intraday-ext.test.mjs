// Unit tests for deriveIntradayExt in pb-core.js — the pure kernel that turns an
// intraday chart result into the live pre/post quote. Regression guard for the
// "after-hours shows for some holdings but not others" bug: Yahoo leaves `volume`
// null on pre/post minute bars, so a genuine ext session is inferred from price
// ACTIVITY (the close moves off the regular close), not move size. A flat-but-
// trading name must surface its live ext price the same as a big mover.
//   cd backend/test && node derive-intraday-ext.test.mjs
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra != null ? ' — ' + extra : ''}`); if (!cond) failures++; };
const { deriveIntradayExt } = PBCore;

// Build a minimal Yahoo chart `result` with an active US post-market session at
// `now`. A regular-close bar (price == regularMarketPrice, before the window) is
// prepended so the series mirrors Yahoo's includePrePost shape; `postCloses` are
// the in-window 1m closes (raw units, USD ⇒ divisor 1).
function postResult(regularMarketPrice, postCloses, now) {
  const nowSec = Math.floor(now / 1000);
  const postStart = nowSec - postCloses.length * 60 - 60;
  const postEnd = nowSec + 3600;
  const regStart = postStart - 6 * 3600, regEnd = postStart;
  const timestamp = [regEnd - 60];          // a regular-session close bar
  const close = [regularMarketPrice];
  for (let i = 0; i < postCloses.length; i++) { timestamp.push(postStart + i * 60); close.push(postCloses[i]); }
  return {
    meta: {
      regularMarketPrice, currency: 'USD',
      currentTradingPeriod: {
        regular: { start: regStart, end: regEnd },
        pre: { start: regStart - 5 * 3600, end: regStart },
        post: { start: postStart, end: postEnd },
      },
    },
    timestamp,
    indicators: { quote: [{ close }] },
  };
}

const NOW = Date.UTC(2026, 5, 29, 22, 25, 0); // Mon 18:25 ET → US post-market

// 1. THE BUG: a flat-but-trading stock. AH prices wiggle but the latest print
//    sits within 0.05% of the close (AAPL-style). The old dead-band hid it
//    entirely; it must now surface the live ext readout like any mover.
{
  const closes = [281.35, 281.69, 281.59, 281.45, 281.25, 281.65, 281.50, 281.47, 281.44, 281.69];
  const ext = deriveIntradayExt(postResult(281.74, closes, NOW), 'US', NOW);
  ok('flat-but-trading post stock surfaces ext readout', ext != null, JSON.stringify(ext));
  ok('  ext price = latest in-window close', ext && Math.abs(ext.extPrice - 281.69) < 1e-9, ext && ext.extPrice);
  ok('  ext kind = post', ext && ext.extKind === 'post', ext && ext.extKind);
  ok('  ext change present and finite', ext && typeof ext.extChange === 'number' && isFinite(ext.extChange), ext && ext.extChange);
}

// 2. GUARD: no genuine after-hours activity — every bar forward-filled at the
//    regular close (no AH market). Stays suppressed (no bogus +0.00% readout).
{
  const ext = deriveIntradayExt(postResult(281.74, [281.74, 281.74, 281.74, 281.74], NOW), 'US', NOW);
  ok('forward-filled flat (no AH trades) stays suppressed', ext == null, JSON.stringify(ext));
}

// 3. REGRESSION: a clear mover still shows, with the right magnitude.
{
  const ext = deriveIntradayExt(postResult(281.74, [283.0, 284.5, 285.1, 284.8], NOW), 'US', NOW);
  ok('clear post-market mover shows', ext != null && ext.extChangePct > 1, ext && ext.extChangePct);
}

// 4. REGRESSION: outside any ext window (regular hours) → null.
{
  const r = postResult(281.74, [281.5, 281.6], NOW);
  const regularNow = r.meta.currentTradingPeriod.regular.start * 1000 + 60 * 1000;
  ok('regular-hours now → no ext', deriveIntradayExt(r, 'US', regularNow) == null, '');
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll deriveIntradayExt tests passed');
process.exit(failures ? 1 : 0);
