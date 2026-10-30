// The SA-morning price feed: why it loaded late, why refresh did nothing, and
// why yesterday kept coming back.
//   cd backend/test && node morning-feed.test.mjs
//
// Jan (2026-10-30): for about a month the SA prices don't load in the morning —
// they seem to arrive only after midday — the refresh button seems to do nothing,
// and the day move looks like a mix of yesterday's and today's. Five defects,
// each pinned below against the real kernels, each verified to FAIL on the code
// it replaces (see the "pristine" note on each block):
//
//   A  the merge accepted an OLDER quote over a newer one   (quoteOlderThan)
//   B  a JSE/LSE close was frozen before the closing auction (quoteSettled grace)
//   C  US rows were withheld from SA midnight to NY midnight (quoteSessionState)
//   D  the sweep fetched in stored order, closed US names first (prioritizeSweep)
//   E  a press waited behind the in-flight sweep, and every URL walked into dead
//      proxies and their full timeout (shouldStop, proxy health, cache key)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import PBCore from '../../pb-core.js';
import PBData from '../../pb-data.js';

let failures = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra != null ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};
const { quoteOlderThan, lastSessionDay, quoteSettled, quoteSessionState, prioritizeSweep, priceKey } = PBCore;
// October 2026: SAST = UTC+2 all year; New York is EDT (UTC-4) until 1 Nov.
const sast = (d, h, m = 0) => Date.UTC(2026, 9, d, h - 2, m);   // 29 Oct = Thursday

const isChild = process.env.PB_MORNING_TZ_CHILD === '1';

if (!isChild) {
  // ── A. Never step a symbol backwards in time ──────────────────────────────
  // Pristine: no such check existed; guardQuote accepted any plausible price, so
  // a proxy-cached pre-open answer (or Stooq's EOD row) replaced today's quote.
  const today = { price: 52, sessionDay: '2026-10-29', regularMarketTime: sast(29, 9, 40), fetchedAt: sast(29, 9, 45) };
  ok('A: yesterday\'s session does not replace today\'s',
    quoteOlderThan(today, { price: 51, sessionDay: '2026-10-28', regularMarketTime: sast(28, 16, 50) }, sast(29, 9, 46)) === true);
  ok('A: Stooq\'s EOD row (yesterday, no tick) does not replace today\'s',
    quoteOlderThan(today, { price: 51, sessionDay: '2026-10-28', source: 'stooq' }, sast(29, 9, 46)) === true);
  ok('A: same session, an EARLIER tick (proxy cached at 09:20) is older',
    quoteOlderThan(today, { price: 51.5, sessionDay: '2026-10-29', regularMarketTime: sast(29, 9, 20) }, sast(29, 9, 46)) === true);
  ok('A: a newer session is accepted',
    quoteOlderThan(today, { price: 53, sessionDay: '2026-10-30', regularMarketTime: sast(30, 9, 20) }, sast(30, 9, 30)) === false);
  ok('A: same session, newer tick is accepted',
    quoteOlderThan(today, { price: 53, sessionDay: '2026-10-29', regularMarketTime: sast(29, 10, 0) }, sast(29, 10, 1)) === false);
  ok('A: an identical tick is accepted (a re-fetch must still refresh fetchedAt)',
    quoteOlderThan(today, Object.assign({}, today, { fetchedAt: sast(29, 9, 50) }), sast(29, 9, 50)) === false);
  ok('A: no held quote → accepted', quoteOlderThan(null, today) === false);
  ok('A: a source that cannot date itself is never blocked',
    quoteOlderThan(today, { price: 50 }, sast(29, 9, 46)) === false);
  ok('A: a held quote ticked in the FUTURE cannot lock the symbol out',
    quoteOlderThan(Object.assign({}, today, { sessionDay: '2026-11-05', regularMarketTime: sast(29, 9, 40) + 7 * 86400000 }),
      { price: 51, sessionDay: '2026-10-29', regularMarketTime: sast(29, 9, 45) }, sast(29, 9, 46)) === false);

  // ── B. The close is only final once the delayed feed has caught up ────────
  // Pristine: quoteSettled(17:06 fetch) === true, so the ~16:50 pre-auction print
  // (Yahoo's JSE feed runs ~15 min late) was frozen as "At close" until the bell.
  ok('B: lastSessionDay — Fri 08:00 SAST (pre-bell) is Thursday', lastSessionDay('JSE', sast(30, 8)) === '2026-10-29');
  ok('B: lastSessionDay — Fri 10:00 SAST is Friday', lastSessionDay('JSE', sast(30, 10)) === '2026-10-30');
  ok('B: lastSessionDay — Mon 08:00 SAST is the Friday before', lastSessionDay('JSE', sast(26, 8)) === '2026-10-23');
  ok('B: lastSessionDay — Saturday is Friday', lastSessionDay('JSE', sast(31, 12)) === '2026-10-30');
  const close = (fetchedAt, over) => Object.assign(
    { price: 100, sessionDay: '2026-10-29', regularMarketTime: sast(29, 16, 50), fetchedAt }, over);
  ok('B: fetched 17:06 SAST (minutes after the close) → NOT settled',
    quoteSettled(close(sast(29, 17, 6)), 'JSE', sast(29, 17, 6)) === false);
  ok('B: ...and still not settled at 08:00 next morning — it gets re-fetched',
    quoteSettled(close(sast(29, 17, 6)), 'JSE', sast(30, 8)) === false);
  ok('B: fetched 17:50 SAST (after the grace) → settled overnight',
    quoteSettled(close(sast(29, 17, 50), { regularMarketTime: sast(29, 17, 0) }), 'JSE', sast(30, 8)) === true);
  ok('B: a quote TWO sessions old is not settled pre-bell, however fresh its fetch',
    quoteSettled(close(sast(29, 18, 0), { sessionDay: '2026-10-28', regularMarketTime: sast(28, 17, 0) }), 'JSE', sast(30, 8)) === false);
  ok('B: a Friday close fetched Friday evening is settled through Monday\'s pre-bell? (no: >24h → re-fetched)',
    quoteSettled(close(sast(23, 18, 0), { sessionDay: '2026-10-23' }), 'JSE', sast(26, 8)) === false);
  ok('B: a Friday close fetched Sunday is settled Monday pre-bell',
    quoteSettled(close(sast(25, 20, 0), { sessionDay: '2026-10-23' }), 'JSE', sast(26, 8)) === true);
  ok('B: US — a fetch during post-market is not settled',
    quoteSettled({ price: 10, sessionDay: '2026-10-29', regularMarketTime: Date.UTC(2026, 9, 29, 20), fetchedAt: Date.UTC(2026, 9, 29, 23, 30) },
      'US', Date.UTC(2026, 9, 30, 6)) === false);
  ok('B: US — a fetch after post closed + grace is settled before SA wakes',
    quoteSettled({ price: 10, sessionDay: '2026-10-29', regularMarketTime: Date.UTC(2026, 9, 29, 20), fetchedAt: Date.UTC(2026, 9, 30, 1, 0) },
      'US', Date.UTC(2026, 9, 30, 6)) === true);

  // ── D. What the user is waiting on goes first ────────────────────────────
  // Pristine: no prioritiser; the order was positions-as-stored, so a book that
  // listed its US names first fetched every closed US name before the open JSE.
  {
    const now = sast(29, 10, 0);                 // JSE open, US closed (04:00 ET = 10:00 SAST is 'pre')
    const now2 = sast(29, 9, 30);                // JSE open, US fully closed
    const P = {
      [priceKey('US', 'AAPL')]: { price: 1, sessionDay: '2026-10-28', regularMarketTime: Date.UTC(2026, 9, 28, 20), fetchedAt: now2 - 3600e3 },
      [priceKey('US', 'MSFT')]: { price: 1, sessionDay: '2026-10-28', regularMarketTime: Date.UTC(2026, 9, 28, 20), fetchedAt: now2 - 3600e3 },
      [priceKey('JSE', 'NPN')]: { price: 1, sessionDay: '2026-10-29', regularMarketTime: sast(29, 9, 20), fetchedAt: now2 - 60e3 },
      [priceKey('TFSA', 'STX40')]: { price: 1, sessionDay: '2026-10-28', regularMarketTime: sast(28, 17, 0), fetchedAt: now2 - 3600e3 },
    };
    const items = [
      { market: 'US', ticker: 'AAPL' }, { market: 'US', ticker: 'MSFT' },
      { market: 'JSE', ticker: 'NPN' }, { market: 'TFSA', ticker: 'STX40' },
      { market: 'JSE', ticker: 'NEW' },          // no quote yet
    ];
    const order = prioritizeSweep(items, P, now2).map(it => it.ticker).join(',');
    ok('D: 09:30 SAST — missing/stale first, then the open JSE, then closed US',
      order === 'STX40,NEW,NPN,AAPL,MSFT', order);
    const flagged = new Set([priceKey('US', 'MSFT')]);
    const order2 = prioritizeSweep(items, P, now2, flagged).map(it => it.ticker).join(',');
    ok('D: a flagged (held / missed) symbol counts as broken', order2 === 'MSFT,STX40,NEW,NPN,AAPL', order2);
    ok('D: the partition is stable and loses nothing',
      prioritizeSweep(items, P, now).length === items.length);
    ok('D: an empty list is fine', prioritizeSweep([], P, now).length === 0);
  }

  // ── E1. A superseded sweep stops at the next batch boundary ──────────────
  // Pristine: fetchQuoteBatch ignored shouldStop and walked all its batches.
  {
    const YQ = (sym) => JSON.stringify({ chart: { result: [{
      meta: { regularMarketPrice: 10, currency: 'USD', regularMarketTime: Math.floor(Date.now() / 1000), symbol: sym },
      timestamp: [Math.floor(Date.now() / 1000) - 86400, Math.floor(Date.now() / 1000)],
      indicators: { quote: [{ close: [9.5, 10] }] } }] } });
    const calls = [];
    globalThis.fetch = async (u) => { calls.push(u); return { ok: true, status: 200, text: async () => YQ('X') }; };
    PBData._setLastGoodProxy(null); PBData._resetProxyHealth();
    const items = Array.from({ length: 24 }, (_, i) => ({ market: 'CRYPTO', ticker: 'C' + i + '-USD' }));
    let batches = 0, missingCalled = false;
    await PBData.fetchQuoteBatch(items, {
      onBatch: () => { batches++; },
      onMissing: () => { missingCalled = true; },
      shouldStop: () => batches >= 1,           // superseded once the first batch landed
    });
    ok('E1: a superseded sweep issues no further batches', batches === 1, `${batches} batch(es)`);
    ok('E1: and publishes no miss list for a plan it abandoned', missingCalled === false);
    const touched = new Set(calls.map(u => (decodeURIComponent(u).match(/chart\/([^?]+)/) || [])[1])).size;
    ok('E1: only the first batch\'s symbols were requested', touched === 8, `${touched} symbols`);
  }

  // ── E2. The auto-poll can no longer be served an arbitrarily old proxy cache ─
  // Pristine: the auto-poll URL carried no key at all (byte-identical forever).
  {
    const urls = [];
    globalThis.fetch = async (u) => { urls.push(decodeURIComponent(u)); return { ok: false, status: 503, text: async () => '' }; };
    PBData._setLastGoodProxy(null); PBData._resetProxyHealth();
    await PBData.fetchQuote('NPN', 'JSE');
    const daily = urls.find(u => /interval=1d/.test(u));
    ok('E2: the auto-poll daily URL carries a per-minute key', /[?&]_b=\d+/.test(daily || ''), daily);
    ok('E2: ...and NOT the manual per-call buster', !/[?&]_=/.test(daily || ''));
    const bucket = Number((daily.match(/_b=(\d+)/) || [])[1]);
    ok('E2: the key is the current minute', Math.abs(bucket - Math.floor(Date.now() / 60000)) <= 1, String(bucket));
    urls.length = 0;
    await PBData.fetchQuote('NPN', 'JSE', { cacheBust: true });
    ok('E2: a manual refresh still uses the per-call buster',
      urls.some(u => /interval=1d/.test(u) && /[?&]_=\d+/.test(u)));
  }

  // ── E3. A dead proxy stops costing every URL its timeout ─────────────────
  // Pristine: only the last SUCCESS floated forward; a dead edge stayed in its
  // slot. That is cheap while the front-runner answers every request, and ruinous
  // the moment it is rate-limited part of the time (which free proxies routinely
  // are): every refused URL then walks into each dead edge and waits out its full
  // 8s timeout. Simulated: three hosts dead (four ladder entries), corsproxy.io
  // refusing every other request with 429, codetabs healthy. Counted: requests
  // spent on dead edges over a 20-URL sweep. Pristine pb-data spends 40 here.
  {
    const DEAD = ['corsmirror.com', 'api.cors.lol', 'allorigins.win'];
    const GOOD_BODY = '{"chart":{"result":[{"meta":{"regularMarketPrice":1}}]}}';
    let wasted = 0;
    const seen = {};
    globalThis.fetch = async (u) => {
      if (DEAD.some(d => u.includes(d))) { wasted++; throw new Error('timeout'); }
      // The two live edges each refuse every other request they get — the shape a
      // per-IP rate limit takes when one device is carrying the whole sweep.
      const host = u.includes('corsproxy.io') ? 'corsproxy' : 'codetabs';
      if ((seen[host] = (seen[host] || 0) + 1) % 2 === 0) return { ok: false, status: 429, text: async () => '' };
      return { ok: true, status: 200, text: async () => GOOD_BODY };
    };
    PBData._setLastGoodProxy(null); PBData._resetProxyHealth();
    for (let i = 0; i < 20; i++) await PBData.fetchViaProxies('https://query1.finance.yahoo.com/v8/finance/chart/S' + i);
    ok('E3: each dead edge is paid for at most PROXY_TRIP (2) times, not once per refused URL',
      wasted <= 4 * 2, `${wasted} requests to dead edges for 20 URLs`);
    const order = PBData.orderedProxies().map(p => p.name);
    ok('E3: the tripped edges sit at the back of the ladder',
      ['corsmirror', 'cors.lol', 'allorigins-get', 'allorigins-raw'].every(n =>
        order.indexOf(n) > order.indexOf('codetabs') && order.indexOf(n) > order.indexOf('corsproxy.io')),
      order.join(' > '));
    // A 404 is Yahoo's answer about the SYMBOL — it must not cool the proxy.
    PBData._setLastGoodProxy(null); PBData._resetProxyHealth();
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
    for (let i = 0; i < 4; i++) await PBData.fetchViaProxies('https://query1.finance.yahoo.com/v8/finance/chart/GONE' + i);
    ok('E3: a 404 does not trip anything', PBData.orderedProxies()[0].name === 'corsmirror');
    // One success clears the record: a proxy that came back is not punished.
    globalThis.fetch = async (u) => (u.includes('corsmirror')
      ? { ok: true, status: 200, text: async () => GOOD_BODY } : { ok: false, status: 503, text: async () => '' });
    PBData._resetProxyHealth();
    PBData._setLastGoodProxy(null);
    await PBData.fetchViaProxies('https://query1.finance.yahoo.com/v8/finance/chart/BACK');
    ok('E3: a recovered proxy is at the front again', PBData.orderedProxies()[0].name === 'corsmirror');
    PBData._resetProxyHealth(); PBData._setLastGoodProxy(null);
  }

  // ── C runs in a South-African device zone (and a Dutch one) ──────────────
  const self = fileURLToPath(import.meta.url);
  for (const TZ of ['Africa/Johannesburg', 'Europe/Amsterdam']) {
    const r = spawnSync(process.execPath, [self], { env: Object.assign({}, process.env, { TZ, PB_MORNING_TZ_CHILD: '1' }), encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) { failures++; process.stdout.write(r.stderr || ''); }
  }
} else {
  // ── C. A US row is the US session's move — on New York's calendar ────────
  // Pristine (TZ=Africa/Johannesburg): 01:00 and 05:30 SAST read 'stale', i.e.
  // every US row withheld its move from SA midnight until NY midnight (06:00 SAST
  // in EDT, 07:00 SAST from 1 Nov).
  const where = (m) => `${m} [TZ=${process.env.TZ}]`;
  const us = { price: 10, sessionDay: '2026-10-29', regularMarketTime: Date.UTC(2026, 9, 29, 20, 0), fetchedAt: Date.UTC(2026, 9, 29, 22, 0) };
  for (const [lbl, t] of [['23:30 SAST', sast(29, 23, 30)], ['01:00 SAST', sast(30, 1)], ['05:30 SAST', sast(30, 5, 30)], ['06:30 SAST', sast(30, 6, 30)]]) {
    ok(where(`C: US Thursday quote at ${lbl} Friday → atClose`), quoteSessionState(us, 'US', t) === 'atClose', quoteSessionState(us, 'US', t));
  }
  // The aggregates keep the VIEWER's day on purpose: after SA midnight the US
  // session belongs to the user's yesterday, so it stays out of the "Today" pill.
  ok(where('C: ...but it is not counted in the viewer\'s "Today"'),
    PBCore.quoteTradedToday(us, 'US', sast(30, 1)) === false);
  // What must NOT change: a quote genuinely a session behind is still 'stale'.
  ok(where('C: US open, quote from the previous NY session → still stale'),
    quoteSessionState(Object.assign({}, us, { sessionDay: '2026-10-28', regularMarketTime: Date.UTC(2026, 9, 28, 20) }), 'US', sast(29, 17)) === 'stale');
  ok(where('C: JSE open 09:30, Wednesday quote → still stale'),
    quoteSessionState({ price: 1, sessionDay: '2026-10-28', regularMarketTime: sast(28, 17) }, 'JSE', sast(29, 9, 30)) === 'stale');
  ok(where('C: JSE open 09:30, today\'s quote → live'),
    quoteSessionState({ price: 1, sessionDay: '2026-10-29', regularMarketTime: sast(29, 9, 20) }, 'JSE', sast(29, 9, 30)) === 'live');
  process.exit(failures ? 1 : 0);
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll morning-feed tests passed');
process.exit(failures ? 1 : 0);
