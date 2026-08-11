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

console.log(failures ? `\n${failures} test(s) failed` : '\nAll sweep-misses tests passed');
process.exit(failures ? 1 : 0);
