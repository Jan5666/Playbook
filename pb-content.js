// Playbook static content — the indicator/index catalog, plain-English indicator
// explanations, and the built-in macro calendar. Pure data (no logic, no React,
// no DOM). Dual-mode: browser global `window.PBContent` + CommonJS for Node tests.
// Loaded before app.js; app.js binds each value via `const X = PBContent.X`.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PBContent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

const RIBBON_CATALOG = [
  { key: 'US:^SPX',    ticker: '^SPX',    market: 'US', label: 'S&P 500',         short: 'S&P',  decimals: 0, invertColor: false },
  { key: 'US:^VIX',    ticker: '^VIX',    market: 'US', label: 'VIX',             short: 'VIX',  decimals: 2, invertColor: true  },
  { key: 'US:^DJI',    ticker: '^DJI',    market: 'US', label: 'Dow Jones',       short: 'DOW',  decimals: 0, invertColor: false },
  { key: 'US:^IXIC',   ticker: '^IXIC',   market: 'US', label: 'Nasdaq',          short: 'NDQ',  decimals: 0, invertColor: false },
  { key: 'US:^FTSE',   ticker: '^FTSE',   market: 'US', label: 'FTSE 100',        short: 'FTSE', decimals: 0, invertColor: false },
  { key: 'US:^N225',   ticker: '^N225',   market: 'US', label: 'Nikkei 225',      short: 'N225', decimals: 0, invertColor: false },
  { key: 'US:^GDAXI',  ticker: '^GDAXI',  market: 'US', label: 'DAX',             short: 'DAX',  decimals: 0, invertColor: false },
  { key: 'US:GC=F',    ticker: 'GC=F',    market: 'US', label: 'Gold',            short: 'GOLD', decimals: 2, invertColor: false },
  { key: 'US:SI=F',    ticker: 'SI=F',    market: 'US', label: 'Silver',          short: 'SLVR', decimals: 2, invertColor: false },
  { key: 'US:CL=F',    ticker: 'CL=F',    market: 'US', label: 'Crude Oil (WTI)', short: 'OIL',  decimals: 2, invertColor: false },
  { key: 'US:BZ=F',    ticker: 'BZ=F',    market: 'US', label: 'Brent Crude',     short: 'BRNT', decimals: 2, invertColor: false },
  { key: 'US:NG=F',    ticker: 'NG=F',    market: 'US', label: 'Natural Gas',     short: 'NGAS', decimals: 3, invertColor: false },
  { key: 'US:HG=F',    ticker: 'HG=F',    market: 'US', label: 'Copper',          short: 'CPPR', decimals: 3, invertColor: false },
  { key: 'US:PL=F',    ticker: 'PL=F',    market: 'US', label: 'Platinum',        short: 'PLAT', decimals: 2, invertColor: false },
  { key: 'US:BTC-USD', ticker: 'BTC-USD', market: 'US', label: 'Bitcoin',         short: 'BTC',  decimals: 0, invertColor: false },
  { key: 'US:ETH-USD', ticker: 'ETH-USD', market: 'US', label: 'Ethereum',        short: 'ETH',  decimals: 0, invertColor: false },
  // ── Macro & rates ──────────────────────────────────────────────────────────
  // These carry a `unit` (so the app formats them as %/points/score, not "$…"),
  // an optional non-Yahoo `source`, and chart range hints. `unit` is also the
  // flag the UI uses to switch a card into "indicator" mode (explanation card,
  // unit-aware price block, no fundamentals/news).
  { key: 'US:^TNX', ticker: '^TNX', market: 'US', label: '10-Year Treasury Yield', short: 'US10Y', decimals: 2, invertColor: false,
    group: 'macro', unit: 'pct',   defaultRange: '1y' },
  { key: 'US:DX-Y.NYB', ticker: 'DX-Y.NYB', market: 'US', label: 'U.S. Dollar Index (DXY)', short: 'DXY', decimals: 2, invertColor: false,
    group: 'macro', unit: 'index', defaultRange: '1y' },
  { key: 'US:^DJT', ticker: '^DJT', market: 'US', label: 'Dow Jones Transports (DJT)', short: 'DJT', decimals: 0, invertColor: false,
    group: 'macro', unit: 'index', defaultRange: '1y' },
  { key: 'MACRO:FEDFUNDS', ticker: 'FEDFUNDS', market: 'MACRO', label: 'Federal Funds Rate', short: 'FEDFUNDS', decimals: 2, invertColor: false,
    group: 'macro', unit: 'pct',   source: 'fred', fredSeries: 'DFF',       fredTransform: 'level',      defaultRange: '1y', chartRanges: ['3mo','6mo','1y','5y','max'] },
  { key: 'MACRO:CPI', ticker: 'CPI', market: 'MACRO', label: 'Inflation — CPI (YoY)', short: 'CPI', decimals: 1, invertColor: false,
    group: 'macro', unit: 'pct',   source: 'fred', fredSeries: 'CPIAUCSL',  fredTransform: 'yoy',        defaultRange: '5y', chartRanges: ['1y','5y','max'] },
  { key: 'MACRO:NFP', ticker: 'NFP', market: 'MACRO', label: 'Non-Farm Payrolls', short: 'NFP', decimals: 0, invertColor: false,
    group: 'macro', unit: 'k_jobs', source: 'fred', fredSeries: 'PAYEMS',   fredTransform: 'mom_change', defaultRange: '5y', chartRanges: ['1y','5y','max'] },
  { key: 'MACRO:GLI', ticker: 'GLI', market: 'MACRO', label: 'Global Liquidity (proxy)', short: 'GLI', decimals: 2, invertColor: false,
    group: 'macro', unit: 'usd_t', source: 'gli',                                                        defaultRange: '5y', chartRanges: ['1y','5y','max'] },
  { key: 'MACRO:FNG', ticker: 'FNG', market: 'MACRO', label: 'Fear & Greed (VIX-based)', short: 'F&G', decimals: 0, invertColor: false,
    group: 'macro', unit: 'score', source: 'vixmood',                                                    defaultRange: '1y', chartRanges: ['1mo','3mo','6mo','1y','5y','max'] },
];
const RIBBON_CATALOG_MAP = Object.fromEntries(RIBBON_CATALOG.map(r => [r.key, r]));

// Plain-English deep-dives shown on each indicator's card. Kept short and
// jargon-light on purpose — the goal is to help a retail investor understand
// what the number means and how to read it. Keyed by the catalog `key`.
const INDICATOR_INFO = {
  'US:^TNX': {
    what: "The interest rate the U.S. government pays to borrow money for 10 years. It's the world's benchmark “risk-free” rate — it sets the tone for mortgages, loans, and how every other asset (stocks included) gets valued.",
    interpret: "Rising yields make borrowing pricier and bonds more competitive with stocks — usually a headwind, especially for expensive growth names. Falling yields mean cheaper money and are generally supportive for stocks. Watch the trend more than today's exact number.",
    levels: [{ label: 'Low', range: 'below 3%' }, { label: 'Normal (recent years)', range: '3–4.5%' }, { label: 'Elevated', range: 'above 5%' }]
  },
  'US:DX-Y.NYB': {
    what: "Measures the U.S. dollar's strength against a basket of major currencies (euro, yen, pound and others). Around 100 is the long-run baseline.",
    interpret: "A rising dollar (higher DXY) tends to pressure commodities like gold and oil, emerging markets, and U.S. companies that earn a lot overseas. A falling dollar is usually a tailwind for those same assets.",
    levels: [{ label: 'Weak', range: 'below ~95' }, { label: 'Neutral', range: '~100' }, { label: 'Strong', range: 'above ~105' }]
  },
  'US:^DJT': {
    what: "Tracks 20 major U.S. transport companies — airlines, railroads, trucking and delivery firms. Because they physically move goods, they're an early read on real economic activity.",
    interpret: "When transports rise alongside the broader market it confirms a healthy economy (the old “Dow Theory”). When they fall or lag while the Dow keeps climbing, it can be an early warning that growth is slowing."
  },
  'MACRO:FEDFUNDS': {
    what: "The Federal Reserve's key short-term interest rate — what U.S. banks charge each other overnight. The Fed raises it to cool inflation and cuts it to support growth. (Shown here is the effective rate; the Fed actually sets a target range.)",
    interpret: "Higher rates make borrowing more expensive and slow the economy — generally a headwind for stocks, especially growth. Lower rates mean cheaper money and are usually supportive. Markets care most about the direction and the Fed's next likely move."
  },
  'MACRO:CPI': {
    what: "The main inflation gauge: how much prices for everyday goods and services have risen over the past 12 months (year-over-year). Updated monthly.",
    interpret: "The Fed targets about 2%. Hotter CPI pushes the Fed toward higher rates (a headwind for stocks and bonds); cooling CPI gives the Fed room to ease, which markets usually welcome.",
    levels: [{ label: 'Fed target', range: '~2%' }, { label: 'Elevated', range: '3–5%' }, { label: 'Hot', range: 'above 5%' }]
  },
  'MACRO:NFP': {
    what: "The number of jobs the U.S. economy added (or lost) last month, excluding farms. Released the first Friday of each month — one of the most market-moving data points there is.",
    interpret: "Strong job growth signals a healthy economy, but if it runs too hot it can keep the Fed hawkish (rates higher for longer). Weak or negative payrolls point to a slowing economy and can push the Fed to cut. Markets judge it against expectations.",
    levels: [{ label: 'Soft', range: 'below ~100K' }, { label: 'Solid', range: '~150–250K' }, { label: 'Hot', range: 'above ~300K' }]
  },
  'MACRO:GLI': {
    what: "A transparent proxy for “global liquidity” — the combined balance sheets of the world's three biggest central banks (U.S. Fed, European Central Bank, Bank of Japan), converted to U.S. dollars. (A do-it-yourself proxy, not the proprietary CrossBorder Capital index.)",
    interpret: "Rising liquidity (central banks expanding) tends to lift risk assets — stocks, crypto, gold. Falling liquidity (tightening / quantitative tightening) is often a headwind. Think of it as a slow-moving tide: watch the direction over months, not days."
  },
  'MACRO:FNG': {
    what: "A 0–100 market-mood gauge built from the VIX (Wall Street's “fear index”): 0 = extreme fear, 100 = extreme greed. A transparent VIX-based stand-in for the popular Fear & Greed gauge.",
    interpret: "Extreme fear (low readings) often marks moments of maximum pessimism — historically closer to bottoms than tops. Extreme greed (high readings) suggests complacency and can precede pullbacks. The classic contrarian rule: be cautious when others are greedy, look for opportunity when others are fearful. Use it as a sentiment check, not a precise timing tool.",
    levels: [{ label: 'Extreme fear', range: '0–24' }, { label: 'Neutral', range: '~50' }, { label: 'Extreme greed', range: '76–100' }]
  }
};

// Scheduled 2026 central-bank decision days + recurring data, as an offline
// baseline. Dates are published a year ahead; refresh this list annually. When a
// Perplexity key is set, live AI events are merged in and take precedence.
const BUILTIN_MACRO_2026 = [
  { date: '2026-01-28', title: 'FOMC rate decision', type: 'Fed' },
  { date: '2026-03-18', title: 'FOMC rate decision + projections', type: 'Fed' },
  { date: '2026-04-29', title: 'FOMC rate decision', type: 'Fed' },
  { date: '2026-06-17', title: 'FOMC rate decision + projections', type: 'Fed' },
  { date: '2026-07-29', title: 'FOMC rate decision', type: 'Fed' },
  { date: '2026-09-16', title: 'FOMC rate decision + projections', type: 'Fed' },
  { date: '2026-10-28', title: 'FOMC rate decision', type: 'Fed' },
  { date: '2026-12-09', title: 'FOMC rate decision + projections', type: 'Fed' },
  { date: '2026-01-23', title: 'Bank of Japan policy decision', type: 'BOJ' },
  { date: '2026-03-19', title: 'Bank of Japan policy decision', type: 'BOJ' },
  { date: '2026-04-28', title: 'Bank of Japan policy decision', type: 'BOJ' },
  { date: '2026-06-16', title: 'Bank of Japan policy decision', type: 'BOJ' },
  { date: '2026-07-31', title: 'Bank of Japan policy decision', type: 'BOJ' },
  { date: '2026-09-18', title: 'Bank of Japan policy decision', type: 'BOJ' },
  { date: '2026-10-30', title: 'Bank of Japan policy decision', type: 'BOJ' },
  { date: '2026-12-18', title: 'Bank of Japan policy decision', type: 'BOJ' },
  { date: '2026-01-29', title: 'ECB monetary policy decision', type: 'ECB' },
  { date: '2026-03-12', title: 'ECB monetary policy decision', type: 'ECB' },
  { date: '2026-04-30', title: 'ECB monetary policy decision', type: 'ECB' },
  { date: '2026-06-04', title: 'ECB monetary policy decision', type: 'ECB' },
  { date: '2026-07-16', title: 'ECB monetary policy decision', type: 'ECB' },
  { date: '2026-09-10', title: 'ECB monetary policy decision', type: 'ECB' },
  { date: '2026-10-29', title: 'ECB monetary policy decision', type: 'ECB' },
  { date: '2026-12-17', title: 'ECB monetary policy decision', type: 'ECB' },
  { date: '2026-02-05', title: 'Bank of England Bank Rate decision', type: 'BOE' },
  { date: '2026-03-19', title: 'Bank of England Bank Rate decision', type: 'BOE' },
  { date: '2026-05-07', title: 'Bank of England Bank Rate decision', type: 'BOE' },
  { date: '2026-06-18', title: 'Bank of England Bank Rate decision', type: 'BOE' },
  { date: '2026-08-06', title: 'Bank of England Bank Rate decision', type: 'BOE' },
  { date: '2026-09-17', title: 'Bank of England Bank Rate decision', type: 'BOE' },
  { date: '2026-11-05', title: 'Bank of England Bank Rate decision', type: 'BOE' },
  { date: '2026-12-17', title: 'Bank of England Bank Rate decision', type: 'BOE' },
  { date: '2026-01-29', title: 'SARB MPC rate decision (South Africa)', type: 'SARB' },
  { date: '2026-03-19', title: 'SARB MPC rate decision (South Africa)', type: 'SARB' },
  { date: '2026-05-21', title: 'SARB MPC rate decision (South Africa)', type: 'SARB' },
  { date: '2026-07-23', title: 'SARB MPC rate decision (South Africa)', type: 'SARB' },
  { date: '2026-09-17', title: 'SARB MPC rate decision (South Africa)', type: 'SARB' },
  { date: '2026-11-19', title: 'SARB MPC rate decision (South Africa)', type: 'SARB' }
];

  // Rules tab: pre-written trim rules, thesis-break triggers, and SA tax-year
  // discipline. Sections keyed by `id`; a bullet is { text } or { strong, text }
  // (a bold lead-in + text). Rendered by RulesView via the `ruleSection` helper.
  const RULES = [
    { id: 'trim', heading: 'Trim rules', bullets: [
      { strong: '+100% gain',            text: ' \u2014 trim 25% of position, bank profits' },
      { strong: '+150% gain',            text: ' \u2014 trim another 20% of remainder' },
      { strong: '+200% gain',            text: ' \u2014 trim another 20%, let the rest ride' },
      { strong: '-20% from cost',        text: ' \u2014 re-examine thesis, never average down without fresh conviction' },
      { strong: 'Position >12% of book', text: ' \u2014 trim to 10% regardless of gain' },
    ]},
    { id: 'thesisBreak', heading: 'Thesis-break triggers', bullets: [
      { text: 'Hyperscaler capex cut by top-3 player (MSFT, GOOGL, META, AMZN, ORCL)' },
      { text: 'Core CPI above 3.2% for two consecutive prints' },
      { text: 'Brent above $120 \u2014 consumer weakness trigger' },
      { text: 'VOO drawdown >15% from buy-zone \u2014 deploy all cash' },
      { text: 'Any position where CEO reneges on publicly-stated commitment (the MSTR lesson)' },
    ]},
    { id: 'saTax', heading: 'SA tax-year discipline', bullets: [
      { text: 'Tax year ends 28 February. Split disposals across 28 Feb + 1 March for two annual R40k CGT exclusions.' },
      { text: 'Combined shelter: up to R80k of gains untaxed per year.' },
      { text: 'At 40% marginal rate with 40% inclusion, each exclusion = ~R12,800 saved.' },
      { text: 'Keep broker IT3(c) certificates for each tax year.' },
    ]},
  ];

const SECTOR_ETF = {
  'Technology':              { etf: 'XLK',  name: 'Technology Select Sector' },
  'Communication Services':  { etf: 'XLC',  name: 'Communication Services' },
  'Consumer Cyclical':       { etf: 'XLY',  name: 'Consumer Discretionary' },
  'Consumer Defensive':      { etf: 'XLP',  name: 'Consumer Staples' },
  'Energy':                  { etf: 'XLE',  name: 'Energy Select Sector' },
  'Financial Services':      { etf: 'XLF',  name: 'Financial Select Sector' },
  'Financials':             { etf: 'XLF',  name: 'Financial Select Sector' },
  'Healthcare':              { etf: 'XLV',  name: 'Health Care Select Sector' },
  'Industrials':             { etf: 'XLI',  name: 'Industrial Select Sector' },
  'Basic Materials':         { etf: 'XLB',  name: 'Materials Select Sector' },
  'Materials':               { etf: 'XLB',  name: 'Materials Select Sector' },
  'Real Estate':             { etf: 'XLRE', name: 'Real Estate Select Sector' },
  'Utilities':               { etf: 'XLU',  name: 'Utilities Select Sector' },
};
const SECTOR_TREND_WINDOWS = [
  { key: '1W', days: 7 },
  { key: '1M', days: 30 },
  { key: '1Y', days: 365 },
  { key: '2Y', days: 730 },
  { key: '3Y', days: 1095 },
  { key: '5Y', days: 1825 },
];
const SECTOR_FWD_PE = {
  'technology': 27, 'information technology': 27,
  'communication services': 19, 'communications': 19,
  'consumer cyclical': 22, 'consumer discretionary': 22,
  'consumer defensive': 19, 'consumer staples': 19,
  'healthcare': 17, 'health care': 17,
  'financial services': 15, 'financials': 15, 'financial': 15,
  'industrials': 20, 'industrial': 20,
  'energy': 12,
  'basic materials': 16, 'materials': 16,
  'real estate': 18,
  'utilities': 17,
};

// UI config: markets & display currencies (client-only, pure data)
const MARKETS = [
  { value: 'US',   label: 'US',   country: 'USA',          exchange: 'NYSE / NASDAQ' },
  { value: 'JSE',  label: 'JSE',  country: 'South Africa',  exchange: 'JSE' },
  { value: 'TFSA', label: 'TFSA', country: 'South Africa',  exchange: 'JSE (Tax-Free)' },
  { value: 'LSE', label: 'LSE', country: 'UK',          exchange: 'London (LSE)' },
  { value: 'ASX', label: 'ASX', country: 'Australia',   exchange: 'ASX' },
  { value: 'FRA', label: 'FRA', country: 'Germany',     exchange: 'XETRA Frankfurt' },
  { value: 'PAR', label: 'PAR', country: 'France',      exchange: 'Euronext Paris' },
  { value: 'AMS', label: 'AMS', country: 'Netherlands', exchange: 'Euronext Amsterdam' },
  { value: 'CRYPTO', label: 'Crypto', country: 'Crypto', exchange: 'Spot \u00b7 24/7' },
];
const DISPLAY_CURRENCIES = [
  { code: 'USD', sym: '$',  label: 'US Dollar' },
  { code: 'ZAR', sym: 'R',  label: 'South African Rand' },
  { code: 'GBP', sym: '\u00a3', label: 'British Pound' },
  { code: 'AUD', sym: 'A$', label: 'Australian Dollar' },
  { code: 'EUR', sym: '\u20ac', label: 'Euro' },
];
const CURRENCY_SYMBOLS = { USD: '$', ZAR: 'R', GBP: '\u00a3', AUD: 'A$', EUR: '\u20ac' };

// Rotation tab copy. Verdict titles keyed by classifyRotation()'s verdict; the
// dynamic detail sentence is built by PBCore.rotationSummary(). Phase labels
// keyed by marketSession()'s phase. ASCII only (no build step; special glyphs
// would need \uXXXX escapes).
const ROTATION_COPY = {
  verdicts: {
    inflow: 'Money is flowing into the market',
    outflow: 'Money is leaving the market',
    rotation: 'Money is rotating, not leaving',
    'inflow-rotation': 'Inflows, with rotation underneath',
    'outflow-rotation': 'Outflows, with rotation underneath',
    mixed: 'Mixed - no clear direction',
    quiet: 'Quiet session',
  },
  phase: {
    pre: 'Pre-market',
    open: 'Market open',
    post: 'After hours',
    closed: 'Closed - last session',
  },
  method: 'Flow estimate = index weight x day move (market-cap delta). A price-based proxy, not traded volume.',
};
// Shortened sector names for the tight flow-diagram blocks and legend chips.
const ROTATION_SECTOR_SHORT = {
  'Technology': 'Tech',
  'Communication Services': 'Comm Svcs',
  'Consumer Cyclical': 'Cons Cyclical',
  'Consumer Defensive': 'Cons Defensive',
  'Financial Services': 'Financials',
  'Financials': 'Financials',
  'Healthcare': 'Healthcare',
  'Industrials': 'Industrials',
  'Basic Materials': 'Materials',
  'Materials': 'Materials',
  'Real Estate': 'Real Estate',
  'Energy': 'Energy',
  'Utilities': 'Utilities',
};

// Instrument logo pack. GENERATED — do not hand-edit; run `node tools/build-logos.mjs`.
// Keys are `MARKET:TICKER`. `f` = filename under ./logos/, `b` = bleed (art is
// its own tile), `k` = needs a white backing. No flag = plain, no tile.
// <<< LOGO_MANIFEST_START
const LOGO_MANIFEST = {
  "CRYPTO:AAVE": {"f":"CRYPTO-AAVE.png"},
  "CRYPTO:ADA": {"f":"CRYPTO-ADA.png","k":1},
  "CRYPTO:ALGO": {"f":"CRYPTO-ALGO.png","k":1},
  "CRYPTO:ATOM": {"f":"CRYPTO-ATOM.png","k":1},
  "CRYPTO:AVAX": {"f":"CRYPTO-AVAX.png"},
  "CRYPTO:BCH": {"f":"CRYPTO-BCH.png"},
  "CRYPTO:BNB": {"f":"CRYPTO-BNB.png"},
  "CRYPTO:BTC": {"f":"CRYPTO-BTC.png"},
  "CRYPTO:DOGE": {"f":"CRYPTO-DOGE.png"},
  "CRYPTO:DOT": {"f":"CRYPTO-DOT.png","k":1},
  "CRYPTO:ETC": {"f":"CRYPTO-ETC.png"},
  "CRYPTO:ETH": {"f":"CRYPTO-ETH.png"},
  "CRYPTO:FIL": {"f":"CRYPTO-FIL.png"},
  "CRYPTO:LINK": {"f":"CRYPTO-LINK.png"},
  "CRYPTO:LTC": {"f":"CRYPTO-LTC.png"},
  "CRYPTO:MATIC": {"f":"CRYPTO-MATIC.png"},
  "CRYPTO:MKR": {"f":"CRYPTO-MKR.png"},
  "CRYPTO:SOL": {"f":"CRYPTO-SOL.png"},
  "CRYPTO:TRX": {"f":"CRYPTO-TRX.png","k":1},
  "CRYPTO:UNI": {"f":"CRYPTO-UNI.png"},
  "CRYPTO:USDC": {"f":"CRYPTO-USDC.png"},
  "CRYPTO:USDT": {"f":"CRYPTO-USDT.png"},
  "CRYPTO:XLM": {"f":"CRYPTO-XLM.png","k":1},
  "CRYPTO:XMR": {"f":"CRYPTO-XMR.png"},
  "CRYPTO:XRP": {"f":"CRYPTO-XRP.png","k":1},
  "CRYPTO:XTZ": {"f":"CRYPTO-XTZ.png"},
  "JSE:ABG": {"f":"JSE-ABG.png","k":1},
  "JSE:AGL": {"f":"JSE-AGL.png","b":1},
  "JSE:BTI": {"f":"JSE-BTI.png","k":1},
  "JSE:BVT": {"f":"JSE-BVT.png","k":1},
  "JSE:CFR": {"f":"JSE-CFR.png","k":1},
  "JSE:CPI": {"f":"JSE-CPI.png","k":1},
  "JSE:DSY": {"f":"JSE-DSY.png","b":1},
  "JSE:FSR": {"f":"JSE-FSR.png"},
  "JSE:MTN": {"f":"JSE-MTN.png","b":1},
  "JSE:NPN": {"f":"JSE-NPN.png"},
  "JSE:PRX": {"f":"JSE-PRX.png","b":1},
  "JSE:SBK": {"f":"JSE-SBK.png"},
  "JSE:SHP": {"f":"JSE-SHP.png"},
  "JSE:SOL": {"f":"JSE-SOL.png","b":1},
  "JSE:STX40": {"f":"JSE-STX40.png"},
  "JSE:STX500": {"f":"JSE-STX500.png"},
  "JSE:STXACW": {"f":"JSE-STXACW.png"},
  "JSE:STXCAP": {"f":"JSE-STXCAP.png"},
  "JSE:STXCHN": {"f":"JSE-STXCHN.png"},
  "JSE:STXDIV": {"f":"JSE-STXDIV.png"},
  "JSE:STXEME": {"f":"JSE-STXEME.png"},
  "JSE:STXEMG": {"f":"JSE-STXEMG.png"},
  "JSE:STXFIN": {"f":"JSE-STXFIN.png"},
  "JSE:STXGBD": {"f":"JSE-STXGBD.png"},
  "JSE:STXGOV": {"f":"JSE-STXGOV.png"},
  "JSE:STXID": {"f":"JSE-STXID.png"},
  "JSE:STXIFR": {"f":"JSE-STXIFR.png"},
  "JSE:STXILB": {"f":"JSE-STXILB.png"},
  "JSE:STXIND": {"f":"JSE-STXIND.png"},
  "JSE:STXJGE": {"f":"JSE-STXJGE.png"},
  "JSE:STXLVL": {"f":"JSE-STXLVL.png"},
  "JSE:STXMMT": {"f":"JSE-STXMMT.png"},
  "JSE:STXNDA": {"f":"JSE-STXNDA.png"},
  "JSE:STXNDQ": {"f":"JSE-STXNDQ.png"},
  "JSE:STXPRO": {"f":"JSE-STXPRO.png"},
  "JSE:STXQUA": {"f":"JSE-STXQUA.png"},
  "JSE:STXRAF": {"f":"JSE-STXRAF.png"},
  "JSE:STXRES": {"f":"JSE-STXRES.png"},
  "JSE:STXSHA": {"f":"JSE-STXSHA.png"},
  "JSE:STXWDM": {"f":"JSE-STXWDM.png"},
  "TFSA:STX40": {"f":"TFSA-STX40.png"},
  "TFSA:STX500": {"f":"TFSA-STX500.png"},
  "TFSA:STXACW": {"f":"TFSA-STXACW.png"},
  "TFSA:STXCAP": {"f":"TFSA-STXCAP.png"},
  "TFSA:STXCHN": {"f":"TFSA-STXCHN.png"},
  "TFSA:STXDIV": {"f":"TFSA-STXDIV.png"},
  "TFSA:STXEME": {"f":"TFSA-STXEME.png"},
  "TFSA:STXEMG": {"f":"TFSA-STXEMG.png"},
  "TFSA:STXFIN": {"f":"TFSA-STXFIN.png"},
  "TFSA:STXGBD": {"f":"TFSA-STXGBD.png"},
  "TFSA:STXGOV": {"f":"TFSA-STXGOV.png"},
  "TFSA:STXID": {"f":"TFSA-STXID.png"},
  "TFSA:STXIFR": {"f":"TFSA-STXIFR.png"},
  "TFSA:STXILB": {"f":"TFSA-STXILB.png"},
  "TFSA:STXIND": {"f":"TFSA-STXIND.png"},
  "TFSA:STXJGE": {"f":"TFSA-STXJGE.png"},
  "TFSA:STXLVL": {"f":"TFSA-STXLVL.png"},
  "TFSA:STXMMT": {"f":"TFSA-STXMMT.png"},
  "TFSA:STXNDA": {"f":"TFSA-STXNDA.png"},
  "TFSA:STXNDQ": {"f":"TFSA-STXNDQ.png"},
  "TFSA:STXPRO": {"f":"TFSA-STXPRO.png"},
  "TFSA:STXQUA": {"f":"TFSA-STXQUA.png"},
  "TFSA:STXRAF": {"f":"TFSA-STXRAF.png"},
  "TFSA:STXRES": {"f":"TFSA-STXRES.png"},
  "TFSA:STXSHA": {"f":"TFSA-STXSHA.png"},
  "TFSA:STXWDM": {"f":"TFSA-STXWDM.png"},
  "US:ACWI": {"f":"US-ACWI.png"},
  "US:AGG": {"f":"US-AGG.png"},
  "US:AMZN": {"f":"US-AMZN.png","k":1},
  "US:ARKK": {"f":"US-ARKK.png","k":1},
  "US:ASML": {"f":"US-ASML.png","k":1},
  "US:BND": {"f":"US-BND.png","k":1},
  "US:BRK-B": {"f":"US-BRK-B.png","k":1},
  "US:C": {"f":"US-C.png","k":1},
  "US:CEG": {"f":"US-CEG.png","b":1},
  "US:CRWD": {"f":"US-CRWD.png","k":1},
  "US:DIA": {"f":"US-SPY.png","k":1},
  "US:EEM": {"f":"US-EEM.png"},
  "US:EEMV": {"f":"US-EEMV.png"},
  "US:EFA": {"f":"US-EFA.png"},
  "US:ETN": {"f":"US-ETN.png"},
  "US:GD": {"f":"US-GD.png","k":1},
  "US:GEV": {"f":"US-GEV.png","b":1},
  "US:GLD": {"f":"US-SPY.png","k":1},
  "US:GOOGL": {"f":"US-GOOGL.png","b":1},
  "US:IAU": {"f":"US-IAU.png"},
  "US:IBIT": {"f":"US-IBIT.png"},
  "US:IEF": {"f":"US-IEF.png"},
  "US:IEFA": {"f":"US-IEFA.png"},
  "US:IEMG": {"f":"US-IEMG.png"},
  "US:ITA": {"f":"US-ITA.png"},
  "US:IVV": {"f":"US-IVV.png"},
  "US:IWM": {"f":"US-IWM.png"},
  "US:JEPI": {"f":"US-JEPI.png","k":1},
  "US:JEPQ": {"f":"US-JEPQ.png","k":1},
  "US:LLY": {"f":"US-LLY.png"},
  "US:MSTR": {"f":"US-MSTR.png"},
  "US:NBIS": {"f":"US-NBIS.png","b":1},
  "US:NVDA": {"f":"US-NVDA.png","b":1},
  "US:OXY": {"f":"US-OXY.png"},
  "US:QQQ": {"f":"US-QQQ.png","k":1},
  "US:SCHD": {"f":"US-SCHD.png","k":1},
  "US:SLV": {"f":"US-SLV.png"},
  "US:SMH": {"f":"US-SMH.png","k":1},
  "US:SOXX": {"f":"US-SOXX.png"},
  "US:SPY": {"f":"US-SPY.png","k":1},
  "US:TLT": {"f":"US-TLT.png"},
  "US:TSM": {"f":"US-TSM.png","k":1},
  "US:UNH": {"f":"US-UNH.png","b":1},
  "US:URTH": {"f":"US-URTH.png"},
  "US:USMV": {"f":"US-USMV.png"},
  "US:VEA": {"f":"US-VEA.png","k":1},
  "US:VGT": {"f":"US-VGT.png","k":1},
  "US:VIG": {"f":"US-VIG.png","k":1},
  "US:VOO": {"f":"US-VOO.png","k":1},
  "US:VRTX": {"f":"US-VRTX.png","k":1},
  "US:VT": {"f":"US-VT.png","k":1},
  "US:VTI": {"f":"US-VTI.png","k":1},
  "US:VWO": {"f":"US-VWO.png","k":1},
  "US:VYM": {"f":"US-VYM.png","k":1},
  "US:XLB": {"f":"US-SPY.png","k":1},
  "US:XLC": {"f":"US-SPY.png","k":1},
  "US:XLI": {"f":"US-SPY.png","k":1},
  "US:XLK": {"f":"US-SPY.png","k":1},
  "US:XLP": {"f":"US-SPY.png","k":1},
  "US:XLRE": {"f":"US-SPY.png","k":1},
  "US:XLU": {"f":"US-SPY.png","k":1},
  "US:XLV": {"f":"US-SPY.png","k":1},
  "US:XLY": {"f":"US-SPY.png","k":1},
};
// <<< LOGO_MANIFEST_END

// Market-scoped so `SOL` cannot resolve Sasol art for Solana (see the logo spec).
function logoFor(ticker, market) {
  if (!ticker || !market) return null;
  return LOGO_MANIFEST[market + ':' + ticker] || null;
}

return { RIBBON_CATALOG, RIBBON_CATALOG_MAP, INDICATOR_INFO, BUILTIN_MACRO_2026, RULES, SECTOR_ETF, SECTOR_TREND_WINDOWS, SECTOR_FWD_PE, MARKETS, DISPLAY_CURRENCIES, CURRENCY_SYMBOLS, ROTATION_COPY, ROTATION_SECTOR_SHORT, LOGO_MANIFEST, logoFor };
});
