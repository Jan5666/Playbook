// Playbook import helpers — pure symbol/name matching + CSV/market-inference
// parsers for holdings import. No React/DOM/network. Dual-mode like pb-data.js:
// CommonJS module.exports (Node tests) + globalThis.PBImport (browser <script>
// after pb-core.js, before app.js). Depends only on pb-core (priceKey,
// MARKET_CURRENCY); the DATA-derived ticker universe is injected via
// PBImport.configure({ allTickers }). app.js binds each value via `const X = PBImport.X`.
(function () {
  const PBCore = (typeof module !== 'undefined' && module.exports && typeof require !== 'undefined')
    ? require('./pb-core.js')
    : globalThis.PBCore;
  const { priceKey, MARKET_CURRENCY } = PBCore;

  // App-injected config (set once from app.js via PBImport.configure). Kept here
  // so the module never reaches into app.js/data.js globals.
  const cfg = { allTickers: [] };
  function configure(opts) { if (opts && typeof opts === 'object') Object.assign(cfg, opts); }

// Yahoo exchange-suffix → one of the app's 8 supported markets. Only suffixes the
// app can actually price (build a correct symbol for, in `yahooSymbol`) belong
// here. Anything Yahoo emits for a *secondary* foreign listing the app can't
// price — Vienna (.VI), Milan (.MI), Swiss (.SW), Mexico (.MX), Singapore (.SG),
// and the many German regional venues (.MU/.BE/.DU/.HM/.HA/.ST/.SG…) — is
// deliberately absent so those listings get dropped, not mis-booked as US.
const YAHOO_EXCHANGE_MAP = {
  'JO': 'JSE', 'JNB': 'JSE',
  'L': 'LSE', 'IL': 'LSE', 'LSE': 'LSE',
  'AX': 'ASX', 'ASX': 'ASX',
  'F': 'FRA', 'DE': 'FRA', 'GER': 'FRA', 'FRA': 'FRA',
  'PA': 'PAR', 'PAR': 'PAR',
  'AS': 'AMS', 'AMS': 'AMS'
};
function parseYahooSymbol(sym) {
  if (!sym) return null;
  const dot = sym.lastIndexOf('.');
  if (dot > 0) {
    const suffix = sym.slice(dot + 1).toUpperCase();
    const market = YAHOO_EXCHANGE_MAP[suffix];
    // A dot suffix always denotes an exchange (Yahoo uses '-' for US share
    // classes, e.g. BRK-B). If it isn't one of our supported markets the listing
    // can't be priced correctly, so drop it rather than tagging it as US — that
    // mislabelling is exactly what booked Google/ASML/Berkshire onto obscure
    // foreign venues at the wrong-currency "live rate".
    return market ? { ticker: sym.slice(0, dot), market } : null;
  }
  return { ticker: sym, market: 'US' };
}

// ── Fuzzy company-name matching for import ────────────────────────────────
// Strip legal suffixes / punctuation so "Broadcom Inc." ≈ "broadcom".
function normaliseCompanyName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'’`()\/\-]/g, ' ')
    .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|holdings?|group|grp|ag|sa|nv|se|asa|spa|the|class|cls|adr|ads|ordinary|ord|shares?|reit|trust|fund|enterprises?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// Sørensen–Dice bigram similarity (0..1) — robust to typos/misspellings
// ("brodcom" ≈ "broadcom") which exact/substring checks miss.
function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let inter = 0, bn = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2); bn++;
    const c = grams.get(g);
    if (c > 0) { inter++; grams.set(g, c - 1); }
  }
  return (2 * inter) / ((a.length - 1) + bn);
}
// 0..1 similarity between a query and a candidate company name. Blends exact /
// prefix / substring / token-overlap / bigram / acronym signals so fuzzy and
// abbreviated inputs still land on the right company.
function companyNameScore(query, candidate) {
  const a = normaliseCompanyName(query);
  const b = normaliseCompanyName(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  let score = 0;
  if (b.startsWith(a) || a.startsWith(b)) score = Math.max(score, 0.92);
  else if (b.includes(a) || a.includes(b)) score = Math.max(score, 0.8);
  const at = a.split(' '), bt = b.split(' ');
  const aset = new Set(at), bset = new Set(bt);
  let inter = 0; aset.forEach(t => { if (bset.has(t)) inter++; });
  const uni = new Set([...at, ...bt]).size;
  let j = uni ? inter / uni : 0;
  if (at[0] && at[0] === bt[0]) j += 0.18; // first-word match (e.g. "Anglo …")
  score = Math.max(score, Math.min(0.9, j));
  // Typo tolerance on the despaced strings.
  score = Math.max(score, diceSimilarity(a.replace(/ /g, ''), b.replace(/ /g, '')) * 0.85);
  // Acronym: short query matches the candidate's word initials (IBM → I.B.M.).
  const aFlat = a.replace(/ /g, '');
  if (aFlat.length >= 2 && aFlat.length <= 5 && bt.length >= 2) {
    const initials = bt.map(w => w[0]).join('');
    if (initials === aFlat || initials.startsWith(aFlat)) score = Math.max(score, 0.72);
  }
  return Math.min(1, score);
}
// Strongest name signal for a candidate: its display name, plus any known aliases
// (shorthand / index names). This is what lets an issuer's bond/inflation ETFs
// resolve to their own listing instead of all collapsing onto its flagship fund.
function bestNameScore(query, name, aliases) {
  let best = companyNameScore(query, name);
  if (aliases) {
    for (const a of aliases) {
      const s = companyNameScore(query, a);
      if (s > best) best = s;
    }
  }
  return best;
}
// Decide whether a token looks like a stock symbol rather than a company name.
function looksLikeTickerToken(s) {
  const t = String(s || '').trim().toUpperCase();
  if (!t || /\s/.test(t)) return false;
  return /^[A-Z0-9]{1,5}([.\-:][A-Z]{1,4})?$/.test(t);
}
// Rank live-search + local candidates for a query, biased by the chosen market.
function rankImportCandidates(query, tickerHint, chosenMarket, remote) {
  const pool = [];
  const seen = new Set();
  // Alias lookup by listing key, so a Yahoo result for a known ticker is scored
  // against the same shorthand names the curated entry carries.
  const aliasByKey = {};
  cfg.allTickers.forEach(t => { if (t.aliases) aliasByKey[priceKey(t.market, t.ticker)] = t.aliases; });
  const add = (c) => {
    if (!c || !c.ticker) return;
    const key = priceKey(c.market, c.ticker);
    if (seen.has(key)) return;
    seen.add(key);
    pool.push(c);
  };
  (remote || []).forEach(add);
  // Seed from the app's own known tickers so offline / proxy-down still matches
  // the curated universe (JSE, LSE, US holdings, etc.). Alias-aware so abbreviated
  // ETF names enter the pool instead of being missed (threshold also slightly
  // relaxed for better recall on shortened names).
  const qUpper = String(query || '').toUpperCase();
  cfg.allTickers.forEach(t => {
    if (t.ticker === qUpper || (tickerHint && t.ticker === String(tickerHint).toUpperCase()) ||
        bestNameScore(query, t.name, t.aliases) >= 0.55) {
      add({ ticker: t.ticker, market: t.market, name: t.name, exchange: '', aliases: t.aliases });
    }
  });
  const chosenCcy = (MARKET_CURRENCY[chosenMarket] || {}).code;
  return pool.map(c => {
    const ns = bestNameScore(query, c.name, c.aliases || aliasByKey[priceKey(c.market, c.ticker)]);
    let score = ns * 100;
    if (c.market === chosenMarket) score += 45;                 // market guides the pick
    // Prefer the listing in the account's own currency, then break ties toward the
    // primary listing: a candidate still carrying an exchange suffix in its ticker
    // (e.g. a foreign cross-listing) is the less-likely retail pick.
    const candCcy = (MARKET_CURRENCY[c.market] || {}).code;
    if (chosenCcy && candCcy === chosenCcy) score += 8;
    if (/[.:]/.test(c.ticker)) score -= 6;
    if (tickerHint && c.ticker.toUpperCase() === String(tickerHint).toUpperCase()) score += 35;
    if (c.ticker.toUpperCase() === qUpper) score += 25;          // query itself was a symbol
    return { ...c, score, nameScore: ns };
  }).sort((a, b) => b.score - a.score);
}

// Header-name synonyms, checked in order. First matching column wins per field.
const IMPORT_SYNONYMS = {
  ticker: ['ticker', 'symbol', 'symb', 'code', 'instrument', 'security', 'scrip', 'share code', 'stock code', 'isin'],
  shares: ['shares', 'quantity', 'qty', 'units', 'no. of shares', 'number of shares', 'share qty', 'units held', 'quantity held', 'holding', 'holdings', 'nominal', 'volume', 'position'],
  cost:   ['cost basis', 'avg cost', 'average cost', 'avg. cost', 'cost price', 'unit cost', 'avg price', 'average price', 'avg. price', 'price paid', 'purchase price', 'buy price', 'avg buy price', 'book cost per share', 'entry price', 'vwap', 'cost'],
  total:  ['total cost', 'book cost', 'book value', 'amount invested', 'invested', 'total invested', 'cost value', 'total cost basis'],
  price:  ['last price', 'current price', 'market price', 'last', 'price', 'close'],
  market: ['market', 'exchange', 'mkt', 'listing'],
  currency: ['currency', 'ccy', 'curr'],
  name:   ['name', 'company', 'description', 'security name', 'stock', 'company name', 'instrument name'],
  date:   ['date', 'purchase date', 'buy date', 'trade date', 'acquired', 'date acquired', 'opened'],
};
const CURRENCY_TO_MARKET = { USD: 'US', ZAR: 'JSE', GBP: 'LSE', GBX: 'LSE', GBP_PENCE: 'LSE', AUD: 'ASX', EUR: 'FRA' };
const SUFFIX_TO_MARKET = { JO: 'JSE', JNB: 'JSE', L: 'LSE', LON: 'LSE', AX: 'ASX', ASX: 'ASX', DE: 'FRA', F: 'FRA', FRA: 'FRA', PA: 'PAR', AS: 'AMS' };

// Split a raw ticker like "AGL.JO" or "BHP:AX" into its market + bare symbol.
function splitTickerMarket(raw) {
  if (!raw) return { ticker: '', market: null };
  let s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/[.:]([A-Z]{1,4})$/);
  if (m && SUFFIX_TO_MARKET[m[1]]) {
    return { ticker: s.slice(0, m.index), market: SUFFIX_TO_MARKET[m[1]] };
  }
  return { ticker: s, market: null };
}
function inferMarket(currencyRaw, marketRaw, suffixMarket) {
  if (suffixMarket) return suffixMarket;
  const mr = (marketRaw || '').trim().toUpperCase();
  if (mr) {
    if (MARKET_CURRENCY[mr]) return mr;
    if (/(NYSE|NASDAQ|NMS|NYQ|US|AMEX)/.test(mr)) return 'US';
    if (/(JSE|JOHANNESBURG|JNB)/.test(mr)) return 'JSE';
    if (/(LSE|LONDON)/.test(mr)) return 'LSE';
    if (/(ASX|AUSTRAL)/.test(mr)) return 'ASX';
    if (/(XETRA|FRANKFURT|FRA|DAX)/.test(mr)) return 'FRA';
    if (/(PARIS|EURONEXT PAR)/.test(mr)) return 'PAR';
    if (/(AMSTERDAM)/.test(mr)) return 'AMS';
  }
  const cr = (currencyRaw || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (cr && CURRENCY_TO_MARKET[cr]) return CURRENCY_TO_MARKET[cr];
  return 'US';
}

// Split a single text line into cells, auto-detecting the delimiter. Falls back
// to runs of 2+ spaces (fixed-width / PDF text) when no real delimiter exists.
function splitLine(line) {
  if (line.includes('\t')) return line.split('\t').map(c => c.trim());
  // Markdown table row
  if (/^\s*\|/.test(line)) return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  const commaCount = (line.match(/,/g) || []).length;
  const semiCount = (line.match(/;/g) || []).length;
  if (semiCount > commaCount && semiCount >= 1) return splitCsvLine(line, ';');
  if (commaCount >= 1) return splitCsvLine(line, ',');
  // Whitespace-separated (2+ spaces) — common in copied PDF tables
  const ws = line.trim().split(/\s{2,}/).map(c => c.trim());
  if (ws.length > 1) return ws;
  // Single-space separated: only treat as columns when it actually looks tabular
  // (has a numeric token like "AAPL 10 150"). A line of only words is a single
  // free-text company name ("Anglo American") and must stay intact.
  const tokens = line.trim().split(/\s+/).map(c => c.trim());
  const hasNumberToken = tokens.some(t => /\d/.test(t) && /^[\d.,$£R€%+\-]+$/.test(t));
  return (tokens.length > 1 && hasNumberToken) ? tokens : [line.trim()];
}
// CSV splitter that respects double-quoted fields.
function splitCsvLine(line, delim) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

  const api = { configure, YAHOO_EXCHANGE_MAP, parseYahooSymbol, normaliseCompanyName,
    diceSimilarity, companyNameScore, bestNameScore, looksLikeTickerToken,
    rankImportCandidates, IMPORT_SYNONYMS, CURRENCY_TO_MARKET, SUFFIX_TO_MARKET,
    splitTickerMarket, inferMarket, splitLine, splitCsvLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.PBImport = api;
})();
