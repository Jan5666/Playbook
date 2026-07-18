// Unit tests for the hot-stock providers in pb-data.js — the trending/screener
// merge that feeds the watchlist's "Hot right now" suggestions. Mocks
// globalThis.fetch with canned Yahoo payloads (same pattern as
// data-providers.test.mjs).
//   cd backend/test && node hot-stocks.test.mjs
import PBData from '../../pb-data.js';

let failures = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra != null ? ' — ' + extra : ''}`); if (!cond) failures++; };

// Fixtures mirror real Yahoo payload bulk: each quote row carries the extra
// fields the live endpoints send. That matters — looksLikeProxyError flags
// `"error":` inside the first 200 chars, so an unrealistically tiny fixture
// (like an empty result) is treated as a proxy failure, exactly as in prod.
const trendingJson = (symbols) => JSON.stringify({
  finance: { result: [{ count: symbols.length, quotes: symbols.map(s => ({ symbol: s })), jobTimestamp: 1752812345678, startInterval: 202607181300 }], error: null }
});
const screenerRow = (row) => ({
  language: 'en-US', region: 'US', quoteType: 'EQUITY', typeDisp: 'Equity',
  quoteSourceName: 'Nasdaq Real Time Price', triggerable: true, customPriceAlertConfidence: 'HIGH',
  exchange: 'NMS', fullExchangeName: 'NasdaqGS', market: 'us_market',
  regularMarketPrice: 100, regularMarketVolume: 12345678, marketCap: 987654321000,
  ...row,
});
const screenerJson = (rows) => JSON.stringify({
  finance: { result: [{ quotes: rows.map(screenerRow) }], error: null }
});

// Route fetch by upstream URL fragments embedded in the proxied URL.
function installRoutes(routes /* [match, body|null][] */) {
  globalThis.fetch = async (proxiedUrl) => {
    const dec = decodeURIComponent(String(proxiedUrl));
    for (const [match, body] of routes) {
      if (dec.includes(match)) return { ok: body != null, text: async () => (body == null ? '' : body) };
    }
    return { ok: false, text: async () => '' };
  };
}

// 1. Full merge: trending + gainers + actives. A symbol on several lists sums
//    its source weights and ranks first; junk symbols are dropped; crypto pairs
//    book on CRYPTO; screener names/changePct are carried across the merge.
{
  installRoutes([
    ['/v1/finance/trending/US', trendingJson(['NVDA', 'SMCI', '^GSPC', 'ES=F', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'ABC.JO'])],
    ['scrIds=day_gainers', screenerJson([
      { symbol: 'NVDA', shortName: 'NVIDIA Corporation', regularMarketChangePercent: 8.42 },
      { symbol: 'IONQ', shortName: 'IonQ Inc.', regularMarketChangePercent: 14.1 },
    ])],
    ['scrIds=most_actives', screenerJson([
      { symbol: 'TSLA', shortName: 'Tesla, Inc.', regularMarketChangePercent: { raw: -2.31 } },
    ])],
  ]);
  const hot = await PBData.fetchHotStocks();
  const keys = hot.map(h => h.market + ':' + h.ticker);
  ok('merge returns items', hot.length > 0, JSON.stringify(keys));
  ok('trending+gainer overlap ranks first', keys[0] === 'US:NVDA', keys[0]);
  const nvda = hot.find(h => h.ticker === 'NVDA');
  ok('overlap sums weights above single-source', nvda && hot.every(h => h.hotScore <= nvda.hotScore), nvda && nvda.hotScore);
  ok('screener name carried onto trending symbol', nvda && nvda.name === 'NVIDIA Corporation', nvda && nvda.name);
  ok('screener changePct carried (plain number)', nvda && Math.abs(nvda.changePct - 8.42) < 1e-9, nvda && nvda.changePct);
  const tsla = hot.find(h => h.ticker === 'TSLA');
  ok('formatted {raw} changePct parsed', tsla && Math.abs(tsla.changePct - -2.31) < 1e-9, tsla && tsla.changePct);
  ok('index symbol ^GSPC dropped', !keys.includes('US:^GSPC'), '');
  ok('futures symbol ES=F dropped', !keys.some(k => k.includes('=')), '');
  ok('exchange-suffixed ABC.JO dropped', !keys.some(k => k.includes('ABC')), '');
  ok('BTC-USD books as CRYPTO:BTC', keys.includes('CRYPTO:BTC'), '');
  ok('crypto capped at 2', hot.filter(h => h.market === 'CRYPTO').length <= 2, String(hot.filter(h => h.market === 'CRYPTO').length));
  ok('trending-only symbol has null changePct', hot.find(h => h.ticker === 'SMCI') && hot.find(h => h.ticker === 'SMCI').changePct === null, '');
}

// 2. Screener auth-walled / proxies down for screeners: trending alone still works.
{
  installRoutes([
    ['/v1/finance/trending/US', trendingJson(['PLTR', 'AMD', 'COIN', 'MRVL', 'SNOW', 'UBER'])],
  ]);
  const hot = await PBData.fetchHotStocks();
  ok('trending-only degradation works', hot.length === 6 && hot[0].ticker === 'PLTR', JSON.stringify(hot.map(h => h.ticker)));
}

// 3. Everything down -> empty list, no throw.
{
  installRoutes([]);
  const hot = await PBData.fetchHotStocks();
  ok('all sources down -> []', Array.isArray(hot) && hot.length === 0, JSON.stringify(hot));
}

// 4. fetchTrendingSymbols returns the raw symbol list.
{
  installRoutes([['/v1/finance/trending/US', trendingJson(['AAPL', 'MSFT', 'GOOG', 'AMZN', 'META', 'NFLX'])]]);
  const syms = await PBData.fetchTrendingSymbols(10);
  ok('fetchTrendingSymbols lists symbols', JSON.stringify(syms.slice(0, 2)) === JSON.stringify(['AAPL', 'MSFT']) && syms.length === 6, JSON.stringify(syms));
}

// 5. BRK-B style class shares survive the symbol filter; long pairs like
//    RENDER-USD map to crypto.
{
  installRoutes([['/v1/finance/trending/US', trendingJson(['BRK-B', 'RENDER-USD', 'AAPL', 'MSFT', 'GOOG', 'AMZN'])]]);
  const hot = await PBData.fetchHotStocks();
  const keys = hot.map(h => h.market + ':' + h.ticker);
  ok('class-share BRK-B kept as US', keys.includes('US:BRK-B'), JSON.stringify(keys));
  ok('RENDER-USD books as CRYPTO:RENDER', keys.includes('CRYPTO:RENDER'), '');
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll hot-stocks tests passed');
process.exit(failures ? 1 : 0);
