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

// ─── FINAL (session-over) extended-hours readout ─────────────────────────────
// The overnight/weekend upgrade: after the post session ends the derive now
// returns the post session's FINAL move (extLive:false) instead of null, so the
// "move after the close" stays readable until the next session prints. Windows
// anchor to meta.tradingPeriods (the bars' own day); with only
// currentTradingPeriod (which rolls to the NEXT day at exchange midnight) the
// windows are walked back day-by-day until they cover the last bar.

// US session windows (UTC seconds) for a given UTC midnight, EDT offsets.
function dayPeriods(dayUtcMs) {
  const sec = Math.floor(dayUtcMs / 1000);
  return {
    pre:     { start: sec + 8 * 3600,           end: sec + 13 * 3600 + 1800 },
    regular: { start: sec + 13 * 3600 + 1800,   end: sec + 20 * 3600 },
    post:    { start: sec + 20 * 3600,          end: sec + 24 * 3600 },
  };
}
// Chart result with explicit bars + either tradingPeriods (object form) and/or
// currentTradingPeriod, mirroring Yahoo's includePrePost intraday shape.
function chartResult(regularMarketPrice, bars, { tradingPeriods, ctp } = {}) {
  const meta = { regularMarketPrice, currency: 'USD' };
  if (tradingPeriods) meta.tradingPeriods = {
    pre: [[tradingPeriods.pre]], regular: [[tradingPeriods.regular]], post: [[tradingPeriods.post]]
  };
  if (ctp) meta.currentTradingPeriod = ctp;
  return { meta, timestamp: bars.map(b => b.t), indicators: { quote: [{ close: bars.map(b => b.c) }] } };
}
const MON = Date.UTC(2026, 5, 29);          // Mon 2026-06-29 00:00 UTC
const TUE = Date.UTC(2026, 5, 30);
const FRI = Date.UTC(2026, 5, 26);
const monP = dayPeriods(MON), tueP = dayPeriods(TUE), friP = dayPeriods(FRI);
const CLOSE = 100;
// Monday bars: a regular-session close bar, then three post-market trades.
const monBars = [
  { t: monP.regular.end - 60, c: CLOSE },
  { t: monP.post.start + 60,  c: 101.0 },
  { t: monP.post.start + 300, c: 101.5 },
  { t: monP.post.start + 900, c: 102.2 },
];

// 5. Overnight (post ended, pre-dawn) with tradingPeriods for the bars' day and
//    ctp already rolled to Tuesday — the after-midnight shape. Tue 01:00 ET.
{
  const r = chartResult(CLOSE, monBars, { tradingPeriods: monP, ctp: tueP });
  const now = (TUE / 1000 + 5 * 3600) * 1000;
  const ext = deriveIntradayExt(r, 'US', now);
  ok('overnight final post readout appears', ext != null, JSON.stringify(ext));
  ok('  final ext price = LAST post trade', ext && Math.abs(ext.extPrice - 102.2) < 1e-9, ext && ext.extPrice);
  ok('  final ext change vs the close', ext && Math.abs(ext.extChange - 2.2) < 1e-9, ext && ext.extChange);
  ok('  final ext kind = post', ext && ext.extKind === 'post', ext && ext.extKind);
  ok('  final ext is NOT live', ext && ext.extLive === false, ext && String(ext.extLive));
  ok('  final ext asOf = last post bar', ext && ext.extAsOf === (monP.post.start + 900) * 1000, ext && ext.extAsOf);
  ok('  final ext carries NO marketState', ext && !('marketState' in ext), ext && JSON.stringify(Object.keys(ext)));
}

// 6. Weekend with ONLY currentTradingPeriod (already pointing at Monday): the
//    day-shift fallback must walk Monday's windows back to Friday's bars.
{
  const friBars = [
    { t: friP.regular.end - 60, c: CLOSE },
    { t: friP.post.start + 120, c: 98.7 },
    { t: friP.post.start + 600, c: 99.1 },
  ];
  const r = chartResult(CLOSE, friBars, { ctp: monP });
  const satNoon = (FRI / 1000 + 24 * 3600 + 15 * 3600) * 1000; // Sat 15:00 UTC
  const ext = deriveIntradayExt(r, 'US', satNoon);
  ok('weekend (ctp-only) final post readout appears', ext != null, JSON.stringify(ext));
  ok('  weekend ext price = last Friday post trade', ext && Math.abs(ext.extPrice - 99.1) < 1e-9, ext && ext.extPrice);
  ok('  weekend ext not live', ext && ext.extLive === false, ext && String(ext.extLive));
}

// 7. Overnight forward-filled flat (no genuine AH trades) stays suppressed.
{
  const flat = [
    { t: monP.regular.end - 60, c: CLOSE },
    { t: monP.post.start + 60,  c: CLOSE },
    { t: monP.post.start + 300, c: CLOSE },
  ];
  const r = chartResult(CLOSE, flat, { tradingPeriods: monP, ctp: tueP });
  const now = (TUE / 1000 + 5 * 3600) * 1000;
  ok('overnight forward-filled flat stays suppressed', deriveIntradayExt(r, 'US', now) == null, '');
}

// 8. Live post classified via tradingPeriods (no ctp at all) keeps the live
//    shape: extLive true + marketState POST.
{
  const r = chartResult(CLOSE, monBars, { tradingPeriods: monP });
  const now = (monP.post.start + 1200) * 1000;
  const ext = deriveIntradayExt(r, 'US', now);
  ok('live post via tradingPeriods works', ext != null && ext.extLive === true, JSON.stringify(ext));
  ok('  live post asserts marketState POST', ext && ext.marketState === 'POST', ext && ext.marketState);
}

// 9. Regular hours with tradingPeriods → still null (day change is the live figure).
{
  const r = chartResult(CLOSE, monBars, { tradingPeriods: monP, ctp: monP });
  const now = (monP.regular.start + 3600) * 1000;
  ok('regular hours (tradingPeriods) still no ext', deriveIntradayExt(r, 'US', now) == null, '');
}

// 10. The original live-path shape now reports extLive:true.
{
  const closes = [283.0, 284.5, 285.1, 284.8];
  const ext = deriveIntradayExt(postResult(281.74, closes, NOW), 'US', NOW);
  ok('live post (ctp) reports extLive true', ext && ext.extLive === true && ext.marketState === 'POST', JSON.stringify(ext));
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll deriveIntradayExt tests passed');
process.exit(failures ? 1 : 0);
