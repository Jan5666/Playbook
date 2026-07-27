// Per-market logo resolution. The ONE rule this file exists to enforce:
// outside the US market, a bare ticker is never a lookup key. Bare-ticker
// endpoints are US-centric and return the US listing with a 200 — MTN resolves
// to Vail Resorts, SOL to ReneSola. See the spec, §1 Claim A.

export const ISIN_BY_TICKER = {
  'JSE:NPN': 'ZAE000015889', 'JSE:SOL': 'ZAE000006896', 'JSE:MTN': 'ZAE000042164',
  'JSE:SHP': 'ZAE000012084', 'JSE:PRX': 'NL0013654783', 'JSE:FSR': 'ZAE000066304',
  'JSE:CPI': 'ZAE000035861', 'JSE:BVT': 'ZAE000117321', 'JSE:KIO': 'ZAE000085346',
  'JSE:DSY': 'ZAE000022331', 'JSE:AGL': 'GB00B1XZS820', 'JSE:BTI': 'GB0002875804',
  'JSE:CFR': 'CH0210483332', 'JSE:ABG': 'ZAE000255915', 'JSE:SBK': 'ZAE000109815',
};

export const ISSUER_BY_PREFIX = [
  { test: /^STX/,  issuer: 'satrix' },
  { test: /^SYG/,  issuer: 'sygnia' },
  { test: /^ETF/,  issuer: '1nvest' },
  { test: /^NFE/,  issuer: 'newfunds' },
  { test: /^CSP|^CTOP|^COG/, issuer: 'coreshares' },
  { test: /^ASH|^AS[A-Z]{2}ET/, issuer: 'ashburton' },
  { test: /^FNB/,  issuer: 'fnb' },
];

// `page` is fetched through headless Chrome (these sites are JS-rendered — a
// plain fetch returns markup with no icon <link> and no og:image).
// `cropBox` is RELATIVE to the ink box, used to lift a square symbol out of a
// wide wordmark. Satrix's is measured: the X occupies the right ~26%.
export const ISSUERS = {
  satrix: { name: 'Satrix', page: 'https://satrix.co.za/', cropBox: { x: 0.74, y: 0, w: 0.26, h: 1 } },
  sygnia: { name: 'Sygnia', page: 'https://www.sygnia.co.za/' },
  '1nvest': { name: '1nvest', page: 'https://www.1nvest.co.za/' },
  newfunds: { name: 'NewFunds', page: 'https://www.newfunds.co.za/' },
  coreshares: { name: 'CoreShares', page: 'https://coreshares.co.za/' },
  ashburton: { name: 'Ashburton', page: 'https://www.ashburtoninvestments.com/' },
  fnb: { name: 'FNB', page: 'https://www.fnb.co.za/' },
};

export const CRYPTO_ID = {
  BTC: 'btc', ETH: 'eth', XRP: 'xrp', SOL: 'sol', ADA: 'ada', DOGE: 'doge',
  DOT: 'dot', LINK: 'link', LTC: 'ltc', AVAX: 'avax', MATIC: 'matic', UNI: 'uni',
  BCH: 'bch', XLM: 'xlm', ATOM: 'atom', XMR: 'xmr', ETC: 'etc', FIL: 'fil',
  NEAR: 'near', ALGO: 'algo', HBAR: 'hbar', AAVE: 'aave', MKR: 'mkr', TRX: 'trx',
  USDT: 'usdt', USDC: 'usdc', BNB: 'bnb', SHIB: 'shib', TON: 'ton', XTZ: 'xtz',
};

const CRYPTO_CDN = 'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color';

export function issuerFor(ticker) {
  const hit = ISSUER_BY_PREFIX.find(p => p.test.test(ticker));
  return hit ? hit.issuer : null;
}

// Keys whose provider art is KNOWN WRONG. A denied key resolves to nothing, so the
// UI falls back to its monogram rather than showing another company's mark.
// JSE:KIO — every source returns the parent Anglo American "A" for Kumba Iron Ore.
// A confidently wrong logo is worse than none; the owner ruled it must be Kumba or
// nothing. Do not remove an entry here without new art verified by eye.
export const DENY = new Set([
  'JSE:KIO',
]);

// Tickers that must reuse another key's art, so one issuer is never rendered as
// several different marks. Providers return five different State Street variants
// across its nine funds — including two pieces of generic clipart (an orange brick
// square for XLB, a newspaper for XLC) that are not brand marks at all.
export const CANONICAL_ART = {
  'US:DIA': 'US:SPY', 'US:GLD': 'US:SPY', 'US:XLB': 'US:SPY', 'US:XLC': 'US:SPY',
  'US:XLI': 'US:SPY', 'US:XLK': 'US:SPY', 'US:XLP': 'US:SPY', 'US:XLRE': 'US:SPY',
  'US:XLU': 'US:SPY', 'US:XLV': 'US:SPY', 'US:XLY': 'US:SPY',
};

export function chainFor(market, ticker) {
  const out = [];
  if (DENY.has(`${market}:${ticker}`)) return out;
  if (market === 'CRYPTO') {
    const id = CRYPTO_ID[String(ticker).replace(/-USD$/i, '').toUpperCase()];
    // Stock APIs are deliberately absent here: FMP's SOL.png is ReneSola.
    if (id) out.push({ source: 'cryptocurrency-icons', key: 'coin', url: `${CRYPTO_CDN}/${id}.png` });
    return out;
  }
  if (market === 'US') {
    // FMP removed: it is the source of the rejected art (three iShares variants,
    // a bare cropped "i", blank-white QQQ/ARKK). Parqet at size=256 returns
    // high-quality pre-composed brand tiles, verified 16/16 on the measured set.
    out.push({ source: 'parqet', key: 'ticker', url: `https://assets.parqet.com/logos/symbol/${encodeURIComponent(ticker)}?format=png&size=256` });
    return out;
  }
  // Every other market: ISIN only, then the managing house.
  const isin = ISIN_BY_TICKER[`${market}:${ticker}`];
  if (isin) out.push({ source: 'parqet-isin', key: 'isin', url: `https://assets.parqet.com/logos/isin/${isin}?format=png&size=256` });
  const issuer = issuerFor(ticker);
  if (issuer) out.push({ source: 'issuer', key: 'issuer', url: ISSUERS[issuer].page, issuer });
  return out;
}
