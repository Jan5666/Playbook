// What a price sweep KNOWS about the symbols it failed to price.
//   cd backend/test && node sweep-misses.test.mjs
//
// Jan reported the SA tab reading "17 of 18" with one holding's Today cell blank.
// The cell was blank by design (a quote a session behind has its percentage
// withheld), but nothing anywhere could say WHICH holding or WHY, and every cause
// produces the identical screen:
//
//   * fetchQuoteBatch keeps failures out of `results`, and the common failure —
//     fetchQuote resolving null, because fetchViaProxies returns null rather than
//     throwing — matches neither the success branch nor the `rejected` warn.
//   * PBStore.mergePrices is a shallow merge, so a missed symbol keeps rendering
//     its last stored quote: a believable price wearing an old sessionDay.
//   * failStreak resets to 0 whenever ANY symbol lands, so a sweep that priced 59
//     of 60 is indistinguishable from a clean one and the "feed unreachable" toast
//     can never fire on a partial failure.
//
// So the sweep's own miss list — which fetchQuoteBatch already computed for its
// retry pass and then threw away — is the only per-symbol signal that exists.
// This file pins that it is reported, and that the retry actually retries.
import { readFileSync } from 'node:fs';
import PBData from '../../pb-data.js';
import PBCore from '../../pb-core.js';

let failures = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra != null ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// Yahoo's answer for a symbol it does not carry. Not a proxy fault — an answer.
const YAHOO_404 = '{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}';
// Stooq's end-of-day CSV: header + two sessions, close in column 4.
const STOOQ_CSV = 'Date,Open,High,Low,Close,Volume\n2026-08-10,10,11,9,10.50,1000\n2026-08-11,10.5,12,10,11.00,1200';

// The proxied url embeds the upstream one percent-encoded, so these fragments are
// what actually appear in fetch()'s argument.
const wants = (u, frag) => u.includes(frag);

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (proxiedUrl) => {
    calls.push(proxiedUrl);
    const body = handler(proxiedUrl);
    return body == null
      ? { ok: false, text: async () => '' }
      : { ok: true, text: async () => body };
  };
  return calls;
}

// ── AAA prices (via the Stooq fallback), BAD cannot be priced at all ─────────
PBData._setLastGoodProxy(null);
let calls = installFetch((u) => {
  if (wants(u, 'stooq.com')) return wants(u, 's%3Daaa.us') ? STOOQ_CSV : null;
  return YAHOO_404;                       // both tickers unknown to Yahoo
});

let reported = null;
const items = [{ market: 'US', ticker: 'AAA' }, { market: 'US', ticker: 'BAD' }];
let results = await PBData.fetchQuoteBatch(items, { onMissing: (m) => { reported = m; } });

ok('the symbol that priced is in results', !!results[PBCore.priceKey('US', 'AAA')]);
ok('the symbol that failed is absent from results', !results[PBCore.priceKey('US', 'BAD')]);
ok('onMissing fired', Array.isArray(reported));
ok('onMissing names exactly the failed symbol',
  reported.length === 1 && reported[0].ticker === 'BAD' && reported[0].market === 'US',
  JSON.stringify(reported));

// ── The retry pass must not re-request a byte-identical url ──────────────────
// The auto-poll deliberately omits cacheBust on pass 1 to keep benefiting from
// proxy caching. Pass 2 used to inherit that, so the "retry" asked for the exact
// same url and any proxy-cached failure — the very thing that broke pass 1 — was
// served straight back. A retry that cannot see past the cache is not a retry.
const badCalls = calls.filter(u => wants(u, 'chart%2FBAD'));
ok('BAD was tried on both passes', badCalls.length >= 2, `${badCalls.length} attempts`);
ok('pass 1 did NOT cache-bust (proxy caching is deliberate there)',
  !wants(badCalls[0], '%26_%3D'));
ok('the retry pass DOES cache-bust', wants(badCalls[badCalls.length - 1], '%26_%3D'));
ok('the two attempts are genuinely different urls', badCalls[0] !== badCalls[badCalls.length - 1]);

// ── A clean sweep still reports, with an empty list ──────────────────────────
// An empty call is what lets a caller CLEAR a symbol that has since recovered;
// firing only on failure would leave a stale name on screen forever.
PBData._setLastGoodProxy(null);
installFetch((u) => (wants(u, 'stooq.com') ? STOOQ_CSV : YAHOO_404));
reported = null;
await PBData.fetchQuoteBatch([{ market: 'US', ticker: 'AAA' }], { onMissing: (m) => { reported = m; } });
ok('a clean sweep still calls onMissing', Array.isArray(reported));
ok('a clean sweep reports an empty list', reported.length === 0, JSON.stringify(reported));

// ── onMissing is optional ───────────────────────────────────────────────────
PBData._setLastGoodProxy(null);
installFetch(() => YAHOO_404);
results = await PBData.fetchQuoteBatch([{ market: 'US', ticker: 'BAD' }]);
ok('omitting onMissing is safe', Object.keys(results).length === 0);

// ── The sweep must not fight itself ─────────────────────────────────────────
// Jan, 2026-08-13: "it takes very long to update the prices, its been 45min after
// open and its still incorrect ... and even when i force refresh at the top the
// stocks that have not fetched prices still dont update."
//
// The feed was congesting itself. One sweep covers the user's whole universe
// (~100+ symbols, and every US name fetches TWICE while it sits in pre-market, so
// ~200 proxied requests) through six shared free CORS proxies, 8 at a time. That
// outruns SWEEP_WATCHDOG_MS; the watchdog releases loadingRef so the chip can stop
// claiming progress — correct, and it deliberately does not cancel the sweep — and
// 45s later the auto-poll saw loadingRef false and started a SECOND concurrent
// sweep on the same pLimit(8) gate. Then a third. The proxies rate-limit, which
// sends every symbol through all six edges, and the next sweep is slower again.
//
// Three kernels and three source guards pin the way out.
const { quoteSettled, hasExtendedSession } = PBCore;
{
  ok('exports quoteSettled', typeof quoteSettled === 'function');
  ok('exports hasExtendedSession', typeof hasExtendedSession === 'function');

  // hasExtendedSession: only markets with a real pre/post tier.
  ok('hES: US has pre/post', hasExtendedSession('US') === true);
  ok('hES: JSE has none', hasExtendedSession('JSE') === false);
  ok('hES: TFSA has none', hasExtendedSession('TFSA') === false);
  ok('hES: LSE has none', hasExtendedSession('LSE') === false);
  ok('hES: CRYPTO has none', hasExtendedSession('CRYPTO') === false);
  ok('hES: an unknown market falls back to US, i.e. never skips work',
    hasExtendedSession('NOPE') === true);

  // quoteSettled: "can this quote still change before the market next opens?"
  const SAT = Date.parse('2026-08-08T10:00:00Z');            // Saturday
  const JSE_PRE = Date.parse('2026-08-05T05:00:00Z');        // 07:00 SAST, before the bell
  const JSE_OPEN = Date.parse('2026-08-05T08:07:00Z');       // 10:07 SAST, trading
  const q = (over, at) => Object.assign(
    { price: 100, sessionDay: '2026-08-04', regularMarketTime: Date.parse('2026-08-04T15:00:00Z'),
      fetchedAt: at != null ? at : Date.parse('2026-08-04T15:05:00Z') }, over);

  ok('qS: market shut + quote is that session\'s close → settled',
    quoteSettled(q({}, JSE_PRE - 3600000), 'JSE', JSE_PRE) === true);
  ok('qS: market OPEN → never settled, whatever the quote says',
    quoteSettled(q({}, JSE_OPEN - 3600000), 'JSE', JSE_OPEN) === false);
  ok('qS: CRYPTO is never settled (it never closes)',
    quoteSettled(q({ sessionDay: null }, SAT - 3600000), 'CRYPTO', SAT) === false);
  ok('qS: no quote → not settled (so a new holding is always fetched)',
    quoteSettled(null, 'JSE', JSE_PRE) === false);
  ok('qS: no usable price → not settled',
    quoteSettled(q({ price: 0 }, JSE_PRE - 3600000), 'JSE', JSE_PRE) === false);
  // The age bound is the load-bearing half. Before the bell quoteSessionState calls
  // EVERY quote 'atClose', including one that last landed days ago — so without it a
  // symbol that had quietly stopped updating would be skipped all night and only get
  // another chance at the open, which is the exact failure being fixed.
  ok('qS: a quote older than a day is NOT settled, however "atClose" it looks',
    quoteSettled(q({}, JSE_PRE - 3 * 86400000), 'JSE', JSE_PRE) === false);
  ok('qS: a quote with no fetchedAt is not settled',
    quoteSettled(q({ fetchedAt: undefined }), 'JSE', JSE_PRE) === false);
  // A 'stale' quote is exactly what we want to keep retrying, closed market or not.
  ok('qS: a stale quote (a session behind, session already ran) is not settled',
    quoteSettled(q({ sessionDay: '2026-08-03', regularMarketTime: Date.parse('2026-08-03T15:00:00Z') },
      Date.parse('2026-08-05T16:00:00Z')), 'JSE', Date.parse('2026-08-05T16:00:00Z')) === false);
}

// ── Source guards on the sweep's control flow (app.js) ──────────────────────
// These are behaviours no Node suite can execute — usePriceFeed needs React — but
// each one is a regression that already shipped once, so the shape is pinned.
{
  const appSrc = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
  ok('app.js: the auto-poll gates on the sweep\'s real life, not the UI flag',
    /const\s+refresh\s*=\s*useCallback\(\(\)\s*=>\s*\{\s*\n\s*if\s*\(sweepActiveRef\.current\)\s*return;/.test(appSrc));
  ok('app.js: runFetch marks the sweep active',
    /sweepActiveRef\.current\s*=\s*true;/.test(appSrc));
  ok('app.js: and clears it only for the sweep that still owns the flags',
    /if\s*\(seq\s*===\s*sweepSeqRef\.current\)\s*sweepActiveRef\.current\s*=\s*false;/.test(appSrc));
  ok('app.js: the auto-poll skips settled quotes',
    /PBCore\.quoteSettled\(/.test(appSrc));
  ok('app.js: a MANUAL refresh never skips (force covers the whole order)',
    /const\s+due\s*=\s*force\s*\?\s*orderRef\.current\s*:/.test(appSrc));
  ok('app.js: an empty due-list is a no-op, never a failStreak bump',
    /if\s*\(!due\.length\)\s*continue;/.test(appSrc));
  ok('app.js: the sweep flag is released in a finally (a stuck one kills the poll)',
    /\}\s*finally\s*\{[\s\S]{0,500}?sweepActiveRef\.current\s*=\s*false;/.test(appSrc));
  ok('app.js: only one recovery pass runs at a time',
    /if\s*\(recoveryActiveRef\.current\)\s*return;/.test(appSrc));
  ok('app.js: a superseded sweep cannot publish its miss list',
    /onMissing:\s*\(miss\)\s*=>\s*\{\s*\n\s*if\s*\(seq\s*!==\s*sweepSeqRef\.current\)\s*return;/.test(appSrc));
  ok('app.js: the refresh button collects the unhealthy symbols first',
    /const\s+refreshNow\s*=\s*useCallback\(\(\)\s*=>\s*\{\s*\n\s*const\s+unhealthy\s*=\s*collectUnhealthy\(\);/.test(appSrc));
  ok('app.js: the recovery pass always cache-busts',
    /const\s+runRecovery[\s\S]{0,600}?cacheBust:\s*true/.test(appSrc));
  ok('app.js: and is capped so a press can never become a second full sweep',
    /out\.length\s*>=\s*RECOVERY_MAX/.test(appSrc));
  ok('app.js: recovery treats a stale quote as unhealthy',
    /collectUnhealthy[\s\S]{0,800}?quoteSessionState\(q,\s*it\.market\)\s*===\s*'stale'/.test(appSrc));
}

// ── The second Yahoo call is skipped only where it cannot say anything new ───
{
  const dataSrc = readFileSync(new URL('../../pb-data.js', import.meta.url), 'utf8');
  ok('pb-data: the intraday call is gated on intradayRedundant',
    /if\s*\(\(looksStale\s*\|\|\s*inExtHours\)\s*&&\s*!intradayRedundant\)/.test(dataSrc));
  ok('pb-data: only for markets with no pre/post tier',
    /intradayRedundant\s*=[\s\S]{0,200}?!hasExtendedSession\(market\)/.test(dataSrc));
  ok('pb-data: CRYPTO is excluded (24h tape, the daily endpoint really does lag it)',
    /intradayRedundant\s*=\s*market\s*!==\s*'CRYPTO'/.test(dataSrc));
  ok('pb-data: only inside the regular session, and only with today\'s quote in hand',
    /intradayRedundant\s*=[\s\S]{0,300}?phase\s*===\s*'open'[\s\S]{0,200}?quote\.sessionDay\s*===\s*marketDayKey\(/.test(dataSrc));
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll sweep-misses tests passed');
process.exit(failures ? 1 : 0);
