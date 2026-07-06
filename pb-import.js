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
  const { priceKey, MARKET_CURRENCY, parseDecimal } = PBCore;

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

function looksLikeHeader(cells) {
  const joined = cells.join(' ').toLowerCase();
  const all = [].concat(...Object.values(IMPORT_SYNONYMS));
  return all.some(syn => joined.includes(syn));
}
function matchColumn(headers, synonyms, used) {
  const norm = headers.map(h => (h || '').toLowerCase().trim());
  const free = (i) => i >= 0 && !(used && used.has(i));
  // Exact match first, then "contains" — skipping columns already claimed by a
  // more specific field (so "Book Cost" is taken as a total, not a per-share).
  for (const syn of synonyms) {
    const i = norm.findIndex((h, idx) => h === syn && free(idx));
    if (i >= 0) return i;
  }
  for (const syn of synonyms) {
    const i = norm.findIndex((h, idx) => h && h.includes(syn) && free(idx));
    if (i >= 0) return i;
  }
  return -1;
}

// Turn an array-of-rows (each an array of cells) into holding objects.
function rowsToHoldings(rows) {
  const cleaned = rows.filter(r => r && r.some(c => c && String(c).trim() !== '') && !/^[-\s|:]+$/.test(r.join('')));
  if (cleaned.length === 0) return [];
  let headerIdx = -1;
  for (let i = 0; i < Math.min(cleaned.length, 5); i++) {
    if (looksLikeHeader(cleaned[i])) { headerIdx = i; break; }
  }
  let cols, dataRows;
  if (headerIdx >= 0) {
    const headers = cleaned[headerIdx];
    const used = new Set();
    const claim = (syns) => { const i = matchColumn(headers, syns, used); if (i >= 0) used.add(i); return i; };
    // Order matters: claim the more specific fields first so generic ones
    // (e.g. "cost" containing "book cost") don't steal a total/value column.
    cols = {
      ticker:   claim(IMPORT_SYNONYMS.ticker),
      total:    claim(IMPORT_SYNONYMS.total),
      cost:     claim(IMPORT_SYNONYMS.cost),
      shares:   claim(IMPORT_SYNONYMS.shares),
      price:    claim(IMPORT_SYNONYMS.price),
      currency: claim(IMPORT_SYNONYMS.currency),
      market:   claim(IMPORT_SYNONYMS.market),
      date:     claim(IMPORT_SYNONYMS.date),
      name:     claim(IMPORT_SYNONYMS.name),
    };
    dataRows = cleaned.slice(headerIdx + 1);
    if (cols.ticker < 0 && cols.name < 0) { headerIdx = -1; }
  }
  if (headerIdx < 0) {
    // No header row: infer each column's role from the data itself rather than
    // assuming a fixed order. We classify every column across all rows as a
    // date, a number, or text, so the four key fields — date, company/ticker,
    // shares and cost/share — resolve regardless of the order they're pasted in
    // ("2024-10-01, Apple, 10, 150.25" and "AAPL, 10, 150" both work).
    const colCount = Math.max(...cleaned.map(r => r.length));
    const isDateCell = (s) => /\d/.test(s) && (
      /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s) ||
      /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s) ||
      /^\d{1,2}\s+[A-Za-z]{3,}\.?,?\s+\d{2,4}$/.test(s) ||
      /^[A-Za-z]{3,}\.?\s+\d{1,2},?\s+\d{2,4}$/.test(s));
    const isNumCell = (s) => s !== '' && isFinite(parseDecimal(s)) && /^[\d.,\s$£R€%+\-]+$/.test(s);
    const tally = Array.from({ length: colCount }, () => ({ date: 0, num: 0, text: 0, filled: 0 }));
    for (const row of cleaned) {
      for (let i = 0; i < colCount; i++) {
        const s = String(row[i] != null ? row[i] : '').trim();
        if (!s) continue;
        tally[i].filled++;
        if (isDateCell(s)) tally[i].date++;
        else if (isNumCell(s)) tally[i].num++;
        else tally[i].text++;
      }
    }
    const roles = tally.map(t => t.filled === 0 ? 'empty'
      : (t.date >= t.num && t.date >= t.text ? 'date' : (t.num >= t.text ? 'num' : 'text')));
    const numCols = roles.map((r, i) => r === 'num' ? i : -1).filter(i => i >= 0);
    cols = {
      ticker: roles.indexOf('text'),
      shares: numCols[0] != null ? numCols[0] : -1,
      cost:   numCols[1] != null ? numCols[1] : -1,
      total: -1, price: -1, market: -1, currency: -1, name: -1,
      date: roles.indexOf('date'),
    };
    dataRows = cleaned;
  }
  const get = (row, i) => (i >= 0 && i < row.length) ? String(row[i] != null ? row[i] : '').trim() : '';
  const isNumericCell = (c) => { const s = String(c || '').trim(); return s !== '' && isFinite(parseDecimal(s)) && /^[\d.,\s$£R€%+\-]+$/.test(s); };
  const holdings = [];
  for (const row of dataRows) {
    const nameCell = cols.name >= 0 ? get(row, cols.name) : '';
    const tickerCell = cols.ticker >= 0 ? get(row, cols.ticker) : '';
    const shares = parseDecimal(get(row, cols.shares));
    let cost = parseDecimal(get(row, cols.cost));
    if ((!isFinite(cost) || cost <= 0) && cols.total >= 0 && isFinite(shares) && shares > 0) {
      const tot = parseDecimal(get(row, cols.total));
      if (isFinite(tot) && tot > 0) cost = tot / shares;
    }
    if ((!isFinite(cost) || cost <= 0) && cols.price >= 0) {
      const pr = parseDecimal(get(row, cols.price));
      if (isFinite(pr) && pr > 0) cost = pr;
    }
    // Name-first: the markdown almost always lists company names, so the human
    // identifier (name column, else the ticker column) becomes the search query
    // that gets fuzzy-matched to a live listing. A bare symbol token is kept as
    // a hint, but we never coerce a company name into a fake ticker.
    let query = nameCell;
    let tickerHint = null;
    let suffixMarket = null;
    if (tickerCell) {
      const sp = splitTickerMarket(tickerCell);
      suffixMarket = sp.market;
      if (looksLikeTickerToken(tickerCell)) tickerHint = sp.ticker;
      if (!query) query = tickerCell;
    }
    if (!query) {
      const textCells = row.map(c => String(c || '').trim()).filter(c => c && !isNumericCell(c));
      textCells.sort((a, b) => b.length - a.length);
      query = textCells[0] || '';
      if (query && !tickerHint && looksLikeTickerToken(query)) {
        const sp = splitTickerMarket(query);
        tickerHint = sp.ticker; suffixMarket = suffixMarket || sp.market;
      }
    }
    if (!query) continue;
    const marketCol = cols.market >= 0 ? get(row, cols.market) : '';
    // Only a deliberate per-row signal — a ticker exchange suffix (".L"/".DE") or
    // an explicit exchange/market column — may override the market the user chose
    // for the whole import. A currency column alone is intentionally ignored:
    // European brokers quote US shares in EUR, which used to mis-book them onto
    // Frankfurt even when the user explicitly selected US.
    let marketHint = null;
    if (suffixMarket) marketHint = suffixMarket;
    else if (marketCol) {
      const m = inferMarket(null, marketCol, null);
      // inferMarket falls back to 'US' for unrecognised text, so only trust a 'US'
      // result when the column actually names a US venue; otherwise leave it to the
      // chosen market.
      if (m && (m !== 'US' || /\b(US|USA|NYSE|NASDAQ|NMS|NYQ|AMEX|ARCA|BATS)\b/i.test(marketCol))) marketHint = m;
    }
    let purchaseDate = '';
    if (cols.date >= 0) {
      const d = parseImportDate(get(row, cols.date));
      if (d) purchaseDate = d;
    }
    holdings.push({
      query: query.trim(),
      nameHint: nameCell,
      tickerHint,
      marketHint,
      shares: isFinite(shares) ? shares : null,
      costBasis: isFinite(cost) && cost > 0 ? cost : null,
      purchaseDate,
    });
  }
  return holdings;
}
function parseImportDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); // DD/MM/YYYY (assume day-first)
  if (m) {
    let d = +m[1], mo = +m[2];
    if (d > 12 && mo <= 12) { /* clearly DD/MM */ }
    else if (mo > 12) { [d, mo] = [mo, d]; } // was MM/DD
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return '';
}
// Strip leading markdown list markers ("- ", "* ", "+ ", "•", "1. ", "1) ")
// and trailing markdown emphasis so a plain "- **Broadcom**" line becomes
// "Broadcom" before we split it into cells.
function stripListMarker(line) {
  return String(line)
    .replace(/^\s{0,4}([-*+•·–—]\s+|\d{1,3}[.)]\s+)/, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s+/, '')
    .trim();
}
function parseHoldingsFromText(text) {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
    .map(stripListMarker)
    .filter(l => l.trim() !== '');
  const rows = lines.map(splitLine);
  return rowsToHoldings(rows);
}

// Numbers in the Easy Equities UI use a space as the thousands separator and a
// dot as the decimal ("R8 100.69", "0.6010", "157"). Pull the value off a line,
// preferring the right-most number (values are right-aligned beside their label).
const EE_MONEY_RE = /(\d{1,3}(?:[  ,]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
function eeNumFromLine(line) {
  const s = String(line || '');
  EE_MONEY_RE.lastIndex = 0;
  let m, last = null;
  while ((m = EE_MONEY_RE.exec(s))) last = m[1];
  if (last == null) return null;
  const v = parseDecimal(last);
  return isFinite(v) ? v : null;
}
// Find the value for a labelled row. The label and its value usually share one
// OCR line ("Avg. Purchase Price R39.93"); occasionally the value wraps to the
// next line, so we look a couple of lines ahead as a fallback.
function eeFieldValue(lines, labelRe) {
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    const onLine = eeNumFromLine(lines[i].replace(labelRe, ' '));
    if (onLine != null) return onLine;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const n = eeNumFromLine(lines[j]);
      if (n != null) return n;
    }
    return null;
  }
  return null;
}
function isEEDetailScreenshot(text) {
  const t = String(text || '').toLowerCase();
  return /my holding/.test(t)
    || /avg\.?,?\s*purchase\s*price/.test(t)
    || (/#?\s*shares\b/.test(t) && /f\s?s\s?r/.test(t))
    || (/profit\s*\/?\s*loss/.test(t) && /previous\s*close/.test(t));
}
// The Easy Equities broker note (emailed trade confirmation) carries a costs
// table — broker commission / STT / VAT — plus the trade value and total cost,
// none of which a holding page shows. Two of these markers is a confident match.
// NB: this must be tested *before* isEEDetailScreenshot, because the note's own
// "SHARES … FSRs" line would otherwise misread it as a holding page.
function isEEEmailScreenshot(text) {
  const t = String(text || '').toLowerCase();
  const hits = [
    /trade\s*value/, /broker\s*commission/, /trade\s*price/,
    /invoice\s*number/, /securities\s*transfer\s*tax/, /investor\s*protection\s*levy/,
    /total\s*transaction\s*cost/, /settlement\s*date/,
  ].reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  return hits >= 2;
}
// A transaction-history row: "Bought <name> <qty> @ <price>" with a DEBIT/CREDIT
// cash line. Only buys are imported (a "Sold" row would reduce a holding, which
// the add-to-position flow doesn't model).
function isEEHistoryScreenshot(text) {
  const t = String(text || '').toLowerCase();
  return /\bbought\b/.test(t) && /debit\s*\/?\s*credit/.test(t) && /@/.test(text || '');
}
// Chrome / label text that must never be mistaken for an instrument name.
const EE_CHROME_RE = /(profit\s*\/?\s*loss|exchange|^open$|^closed$|^sell$|buy more|my holding|current value|purchase value|purchase price|previous close|dividend rewards|tap here|^pricing$|last updated|selling at|buying at|last price|delayed|biz news|own the market|asset management|portfolio|watchlist|notify|my funds|\btotal\b|my investments|available|net value|account value|view all|all holdings|^(?:jse|jnb|nasdaq|nsdq|nyse|nyq|nms|arca|amex|bats|lse|lon|asx|fra|fwb|etr|par|epa|ams|xetra)$)/i;
// Words that mark a line as a fund / instrument name even when it's short.
const EE_NAME_KW_RE = /(\betf\b|fund|index|feeder|satrix|1nvest|invest|\bivy\b|easyetf|msci|govi|top\s?40|s&p|innovation|managed|equity|bond|property|global|emerging|reit|dividend plus|world|nasdaq|s&p ?500|all ?share)/i;
function eeLooksLikeName(line) {
  const l = String(line || '').trim();
  if (l.length < 3) return false;
  if (/^[0-9R$£€%.,\s:+\-↑↓v^]+$/i.test(l)) return false;   // status bar, P/L, %s
  if (EE_CHROME_RE.test(l)) return false;
  const letters = (l.match(/[A-Za-z]/g) || []).length;
  if (letters < 3) return false;
  const words = l.split(/\s+/).filter(Boolean);
  if (words.length >= 2 || EE_NAME_KW_RE.test(l)) return true;
  // A single-word name ("Naspers", "Visa", "Prosus") is fine too — as long as it
  // isn't an all-caps ticker-shaped token (those are the JSE/US code, not a name).
  return /[a-z]/.test(l) && !/^[A-Z][A-Z0-9]{1,6}$/.test(l);
}
// Strip money / price / percentage tokens (and arrows) out of an OCR'd name, so a
// header that ran into an adjacent value ("Satrix GOVI ETF R125.00") never books
// the amount as part of the holding's name. Bare integers that are genuinely part
// of a name ("Satrix 40", "1nvest S&P 500") are deliberately preserved.
function eeCleanName(s) {
  return String(s || '')
    .replace(/[↑↓▲▼]/g, ' ')
    .replace(/\d+(?:\.\d+)?\s?%/g, ' ')                      // 28.72%  (before the decimal rule eats the number)
    .replace(/[R$£€]\s?\d[\d  .,]*/g, ' ')                 // R8 100.69, $1,234.56
    .replace(/\b\d{1,3}(?:[  ,]\d{3})+(?:\.\d+)?\b/g, ' ') // 8 100.69, 1,234
    .replace(/\b\d+\.\d+\b/g, ' ')                           // 39.93, 1.97, 13.20
    .replace(/[%↑↓]/g, ' ')                                  // any orphaned symbols
    .replace(/\s{2,}/g, ' ')
    .replace(/^[^A-Za-z0-9(]+/, '')                           // leading symbol glyphs (chevron read as <, £, €…)
    // The EE back-chevron at the start of the title bar can OCR as a lone digit
    // ("4 INVEST…", "4 1NVEST…"); drop a single leading digit + space. A real
    // leading number in a name has no following space ("1nvest", "40 ETF", "3M").
    .replace(/^[0-9]\s+(?=[A-Za-z0-9])/, '')
    .replace(/[\s.,:;|%]+$/, '')
    .trim();
}
// Map an Easy Equities EXCHANGE value to the app's market code. EE shows the
// listing exchange (JSE / NYSE / NASDAQ / LSE …) beside the flag — that's where
// the share actually trades, so this works for any market, not just the JSE.
const EE_EXCHANGE_MAP = [
  [/johannesburg|\bjse\b|\bjnb\b/i, 'JSE'],
  [/nasdaq|nsdq|\bnyse\b|\bnms\b|\bnyq\b|\barca\b|\bamex\b|\bbats\b|new york/i, 'US'],
  [/london|\blse\b|\blon\b/i, 'LSE'],
  [/australian|\basx\b/i, 'ASX'],
  [/frankfurt|xetra|\bfra\b|\bfwb\b|\betr\b|\bger\b/i, 'FRA'],
  [/euronext\s*paris|\bpar\b|\bepa\b/i, 'PAR'],
  [/amsterdam|\bams\b/i, 'AMS'],
];
function eeDetectMarket(lines, fallback) {
  const zones = [];
  const idx = lines.findIndex(l => /exchange/i.test(l));
  if (idx >= 0) zones.push(lines.slice(idx, idx + 3).join(' '));  // the value next to EXCHANGE
  zones.push(lines.slice(0, 22).join(' '));                       // else anywhere in the header
  for (const zone of zones) {
    for (const [re, mk] of EE_EXCHANGE_MAP) if (re.test(zone)) return mk;
  }
  // Broker notes / history rows carry no exchange label, but an EasyEquities ZAR
  // account trades the JSE — so a ZAR-denominated note resolves to JSE (still
  // subject to the TFSA override in eeResolveMarket). Lowest-priority signal, so
  // any explicit exchange above always wins.
  if (/\bzar\b/i.test(String(lines.join(' '))) && !/\b(usd|gbp|eur|aud)\b/i.test(String(lines.join(' ')))) return 'JSE';
  return fallback || null;
}
// Resolve a holding's final market: trust the exchange detected on the screenshot,
// falling back to the market the user started from. TFSA holdings list on the JSE,
// so a JSE detection while the user is on the TFSA tab stays TFSA.
function eeResolveMarket(detected, fallback) {
  let m = detected || fallback || 'US';
  if (fallback === 'TFSA' && (m === 'JSE' || m === 'TFSA')) m = 'TFSA';
  return m;
}
// From the header region of a holding page, pick the descriptive instrument name
// and the standalone listing code (e.g. "Satrix 40 ETF" + "STX40", "Apple Inc" + "AAPL").
function eeExtractNameTicker(lines) {
  let cut = lines.findIndex(l => /my holding/i.test(l));
  if (cut < 0) cut = Math.min(lines.length, 18);
  const top = lines.slice(0, cut);
  const TICKER_STOP = /^(JSE|JNB|OPEN|CLOSED|ETF|ETN|ETP|SELL|BUY|USD|ZAR|GBP|EUR|AUD|PROFIT|LOSS|EXCHANGE|NYSE|NASDAQ|NSDQ|NMS|NYQ|ARCA|AMEX|BATS|LSE|LON|ASX|FRA|FWB|ETR|PAR|EPA|AMS|XETRA|MY|FSR|FSRS|R|AMETF|MSCI|STANLIB)$/i;
  // The JSE code sits in its own cell right beside the PROFIT/LOSS · EXCHANGE
  // block, so proximity to those labels — not length — is the reliable signal.
  // (EE codes range from 3-letter share codes like NPN to 6-char ETF codes.)
  const near = (i) => top.slice(Math.max(0, i - 2), i + 3).some(x => /profit|loss|exchange/i.test(x));
  const codeShape = (s) => /^[A-Z][A-Z0-9]{2,6}$/.test(s) && !TICKER_STOP.test(s);
  const tickerCands = [];
  top.forEach((raw, i) => {
    const l = raw.trim();
    if (codeShape(l)) {
      let score = i;                     // later (closer to the holding block) wins ties
      if (near(i)) score += 100;
      if (/\d/.test(l)) score += 5;
      if (l.length >= 5) score += 3;
      tickerCands.push({ l, score });
    }
    // OCR sometimes merges the code with the adjacent PROFIT/LOSS · EXCHANGE
    // labels onto one row ("STX40 PROFIT/LOSS EXCHANGE") — recover the code token.
    if (/profit|loss|exchange/i.test(l) || near(i)) {
      for (const tok of l.split(/\s+/)) {
        if (codeShape(tok) && !/profit|loss|exchange/i.test(tok)) {
          let score = i + 90;
          if (/\d/.test(tok)) score += 5;
          if (tok.length >= 5) score += 3;
          tickerCands.push({ l: tok, score });
        }
      }
    }
  });
  tickerCands.sort((a, b) => b.score - a.score);
  const ticker = tickerCands.length ? tickerCands[0].l : null;
  let best = '', bestScore = -1;
  for (const raw of top) {
    const l = raw.trim().replace(/\s{2,}/g, ' ').replace(/^[^A-Za-z0-9(]+/, '');
    if (!eeLooksLikeName(l)) continue;
    if (ticker && l.toUpperCase() === ticker) continue;
    const cleaned = eeCleanName(l);
    const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
    if (letters < 3) continue;
    const words = cleaned.split(/\s+/).filter(Boolean);
    // eeCleanName already strips any amount, so this is only a mild tiebreak that
    // prefers a pristine header line over one OCR ran a value into.
    const hadMoney = /[R$£€]\s?\d|\b\d+\.\d{2}\b|%|↑|↓/.test(l);
    const score = letters + (EE_NAME_KW_RE.test(cleaned) ? 1000 : 0)
                + (words.length >= 3 ? 50 : 0) - (hadMoney ? 12 : 0);
    if (score > bestScore) { bestScore = score; best = cleaned; }
  }
  return { name: best, ticker };
}
// Pick the fullest clean name out of the dedicated title-bar OCR. The strip holds
// only the title (the back-chevron and any stray status glyphs clean away), so we
// take the line with the most letters after stripping amounts.
function eeBestHeaderName(headerText) {
  if (!headerText) return '';
  const lines = String(headerText).split('\n').map(s => s.replace(/ /g, ' ').trim()).filter(Boolean);
  let best = '', bestLetters = 2;
  for (const raw of lines) {
    const l = raw.replace(/^[^A-Za-z0-9(]+/, '');
    if (!eeLooksLikeName(l)) continue;
    const cleaned = eeCleanName(l);
    const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
    if (letters > bestLetters) { bestLetters = letters; best = cleaned; }
  }
  return best;
}
function parseEEDetailScreenshot(lines, market, headerText) {
  const heur = eeExtractNameTicker(lines);
  const ticker = heur.ticker;
  // The dedicated title-bar read is the authoritative full name (read at full
  // width, so it isn't truncated, and isolated, so no amount bleeds in). Trust it
  // whenever it produced a real name; fall back to the full-page heuristic only
  // when the title strip was missed or came back too short to be a name.
  const headerName = eeBestHeaderName(headerText);
  const name = (headerName.match(/[A-Za-z]/g) || []).length >= 4 ? headerName : heur.name;
  const sharesWhole = eeFieldValue(lines, /#?\s*shares\b/i);
  const fsrs = eeFieldValue(lines, /#?\s*f\s?s\s?rs?\b/i);
  const avgPrice = eeFieldValue(lines, /avg\b[.,]?\s*purchase\s*price/i);
  const purchaseValue = eeFieldValue(lines, /purchase\s*value/i);
  // Easy Equities splits a position into whole "Shares" plus fractional-share
  // rights ("FSRs"); the real quantity — and therefore the value that matches
  // what EE shows — is the sum of the two.
  let shares = sharesWhole != null ? sharesWhole + (fsrs != null ? fsrs : 0) : null;
  let cost = (avgPrice != null && avgPrice > 0) ? avgPrice : null;
  // Cross-fill from Purchase Value (= shares × avg price) when one side is missing.
  if ((shares == null || shares <= 0) && purchaseValue != null && cost != null && cost > 0) shares = purchaseValue / cost;
  if (cost == null && purchaseValue != null && shares != null && shares > 0) cost = purchaseValue / shares;
  const query = name || ticker || '';
  if (!query && shares == null && cost == null) return null;
  return {
    query,
    nameHint: name || '',
    tickerHint: ticker || null,
    marketHint: market,
    shares: (shares != null && isFinite(shares) && shares > 0) ? shares : null,
    costBasis: (cost != null && isFinite(cost) && cost > 0) ? cost : null,
    purchaseDate: '',
  };
}
// Best-effort parse of the Easy Equities portfolio list, where many holdings
// share one screenshot. The list view rarely shows per-share cost, so these
// rows arrive as name-only and the user fills in shares / cost in review.
function parseEEListScreenshot(lines, market) {
  const out = [];
  const seen = new Set();
  for (const raw of lines) {
    const l0 = raw.trim().replace(/\s{2,}/g, ' ');
    if (!eeLooksLikeName(l0)) continue;
    const l = eeCleanName(l0);
    if ((l.match(/[A-Za-z]/g) || []).length < 3) continue;
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ query: l, nameHint: l, tickerHint: null, marketHint: market, shares: null, costBasis: null, purchaseDate: '' });
  }
  return out;
}
// Words that mark a top-of-note line as the instrument's company name, and the
// brokerage chrome (its own name, the account holder, the address, the costs
// table labels) that must never be mistaken for it.
const EE_COMPANY_SUFFIX_RE = /\b(limited|ltd|plc|inc|incorporated|corp|corporation|group|holdings?|company|reit|properties|investments?|capital|resources|industries|international|bank|n\.?v|s\.?a|s\.?e|a\.?g)\b/i;
const EE_EMAIL_CHROME_RE = /(easyequities|first world trader|wework|coworking|oxford|rosebank|johannesburg|south africa|reg\.?\s*no|vat\s*no|account|acc\.?\s*num|trader\s*:|invoice|submission|settlement|broker\s*commission|securities\s*transfer|investor\s*protection|value-?added|easymoney|trade\s*value|trade\s*price|total\s*cost|total\s*transaction|transaction\s*cost|^detail\b|^zar\b|^shares\b|^fsrs?\b|^traded\b|jan\s*stander|biz news)/i;
// Pull a yyyy-mm-dd date from the value of a labelled row (label and value may
// share a line or wrap to the next couple). Tolerates -, / or . separators and
// any trailing time. Returns '' when none is found.
const _eeDateInLine = (l) => {
  const m = String(l).match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  return (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31)
    ? `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}` : '';
};
function eeFindDate(lines, labelRe) {
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      const d = _eeDateInLine(lines[j]);
      if (d) return d;
    }
  }
  return '';
}
// First yyyy-mm-dd anywhere, skipping lines that match excludeRe. Used as the
// trade-date fallback on a broker note so a missed "SUBMISSION DATE" label never
// falls through to the (later) SETTLEMENT DATE — which would mis-date the buy and
// break de-dup against the matching history row.
function eeFirstDate(lines, excludeRe) {
  for (const l of lines) {
    if (excludeRe && excludeRe.test(l)) continue;
    const d = _eeDateInLine(l);
    if (d) return d;
  }
  return '';
}
// The instrument name on a broker note is the prominent line above the "TRADED"
// block. Company-suffix lines (Limited / PLC / Group) win; the brokerage's own
// name, the account holder and the address are filtered out as chrome.
function eeEmailName(lines) {
  let cut = lines.findIndex(l => /\btraded\b|invoice\s*number|submission\s*date/i.test(l));
  if (cut < 0) cut = Math.min(lines.length, 12);
  const top = lines.slice(0, cut);
  let best = '', bestScore = -1;
  for (const raw of top) {
    const l = eeCleanName(raw.replace(/\s{2,}/g, ' '));
    if (l.length < 3 || EE_EMAIL_CHROME_RE.test(l) || !eeLooksLikeName(l)) continue;
    const letters = (l.match(/[A-Za-z]/g) || []).length;
    if (letters < 3) continue;
    const score = letters + (EE_COMPANY_SUFFIX_RE.test(l) ? 1000 : 0)
                + (l.split(/\s+/).filter(Boolean).length >= 2 ? 30 : 0);
    if (score > bestScore) { bestScore = score; best = l; }
  }
  return best;
}
// Parse one emailed broker note into a holding. The split "SHARES | FSRs" cell
// reads poorly, so the share count comes from trade value ÷ trade price (e.g.
// 993.75 / 28.80 = 34.5052). Cost basis is the trade price — the per-share price
// excluding fees, matching the "Avg Purchase Price" the app imports elsewhere.
function parseEEEmailScreenshot(lines, market) {
  const tradePrice = eeFieldValue(lines, /trade\s*price/i);
  let value = eeFieldValue(lines, /trade\s*value/i);
  if (value == null) {
    const total = eeFieldValue(lines, /total\s*cost/i);
    const costs = eeFieldValue(lines, /total\s*transaction\s*cost/i);
    if (total != null && costs != null) value = total - costs;
  }
  const shares = (value != null && tradePrice != null && tradePrice > 0) ? value / tradePrice : null;
  const cost = (tradePrice != null && tradePrice > 0) ? tradePrice : null;
  const name = eeEmailName(lines);
  const date = eeFindDate(lines, /submission\s*date/i) || eeFirstDate(lines, /settlement/i);
  if (!name && shares == null && cost == null) return null;
  return {
    query: name || '', nameHint: name || '', tickerHint: null, marketHint: market,
    shares: (shares != null && isFinite(shares) && shares > 0) ? shares : null,
    costBasis: (cost != null && isFinite(cost) && cost > 0) ? cost : null,
    purchaseDate: date || '',
  };
}
// Parse one transaction-history row ("Bought <name> <qty> @ <price>" + a
// DEBIT/CREDIT cash line). The COMMENT wraps over several OCR lines, so it's
// rejoined before matching. Quantity always carries a decimal, which separates
// it cleanly from any number inside the name.
function parseEEHistoryScreenshot(lines, market) {
  const joined = lines.join(' ').replace(/\s{2,}/g, ' ');
  const m = joined.match(/bought\s+(.+?)\s+(\d[\d,\s]*\.\d+)\s*@\s*R?\s*([\d,\s]*\.?\d+)/i);
  if (!m) return null;
  const name = eeCleanName(m[1]);
  const shares = parseDecimal(m[2]);
  const atPrice = parseDecimal(m[3]);
  const debitRaw = eeFieldValue(lines, /debit\s*\/?\s*credit/i);
  const debit = debitRaw != null ? Math.abs(debitRaw) : null;
  const derived = (debit != null && shares > 0) ? debit / shares : null;
  // The JSE quotes share prices in cents in the history ("@ 2,880.00" = R28.80),
  // but US prices appear in dollars. Rather than hard-code that, pick whichever
  // reading of the "@" price reproduces the cash debit (= shares × price) — which
  // self-corrects the cents convention for any market. The "@" price is exact
  // (the cash debit is only 2-dp), so it's preferred over debit ÷ shares.
  let cost = null;
  if (atPrice != null && atPrice > 0 && derived != null) {
    const asIs = Math.abs(atPrice - derived) / derived;
    const asCents = Math.abs(atPrice / 100 - derived) / derived;
    cost = asCents < asIs ? atPrice / 100 : atPrice;
  } else if (atPrice != null && atPrice > 0) {
    cost = market === 'JSE' ? atPrice / 100 : atPrice;
  } else {
    cost = derived;
  }
  const date = eeFindDate(lines, /\bdate\b/i);
  if (!name && !(isFinite(shares) && shares > 0)) return null;
  return {
    query: name || '', nameHint: name || '', tickerHint: null, marketHint: market,
    shares: (isFinite(shares) && shares > 0) ? shares : null,
    costBasis: (cost != null && isFinite(cost) && cost > 0) ? cost : null,
    purchaseDate: date || '',
  };
}
// Two views of the *same* trade — an emailed broker note and its transaction-
// history row — read as two holdings. Left alone they'd double the position when
// imported (the commit path sums shares per ticker). Collapse rows that share a
// market, date and (to tolerance) share count into one, since EE never books two
// distinct fills at the identical fractional quantity on the same day. Distinct
// buys of the same stock have different quantities, so they survive and merge
// correctly downstream.
const _eeNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function _eeFirstWord(s) { const m = String(s || '').toLowerCase().match(/[a-z]{3,}/); return m ? m[0] : ''; }
function _eeSameTrade(a, b) {
  if (a.marketHint !== b.marketHint) return false;
  if (a.purchaseDate && b.purchaseDate && a.purchaseDate !== b.purchaseDate) return false;
  const sa = a.shares, sb = b.shares;
  if (sa == null || sb == null) return false;
  if (Math.abs(sa - sb) > Math.max(0.001, 0.005 * Math.max(sa, sb))) return false;
  const na = _eeNorm(a.query), nb = _eeNorm(b.query);
  // Same market + same fractional quantity + same day is already conclusive; the
  // name only has to not flatly contradict (OCR may spell it differently across
  // the two views), so a shared leading word is enough.
  if (na && nb && na !== nb && _eeFirstWord(a.query) !== _eeFirstWord(b.query)) return false;
  return true;
}
function dedupeEeHoldings(list) {
  const out = [];
  for (const row of list || []) {
    const hit = out.find(r => _eeSameTrade(r, row));
    if (!hit) { out.push({ ...row }); continue; }
    // Fill any field the kept row is missing, and keep the longer/cleaner name.
    if (hit.costBasis == null && row.costBasis != null) hit.costBasis = row.costBasis;
    if (hit.shares == null && row.shares != null) hit.shares = row.shares;
    if (!hit.purchaseDate && row.purchaseDate) hit.purchaseDate = row.purchaseDate;
    if (!hit.tickerHint && row.tickerHint) hit.tickerHint = row.tickerHint;
    if ((row.query || '').length > (hit.query || '').length) { hit.query = row.query; hit.nameHint = row.nameHint || row.query; }
  }
  return out;
}
// defaultMarket = the market the user started from (the Holdings tab they were on
// when they tapped Import). It's the fallback when a screenshot's own exchange
// can't be read, and it disambiguates JSE vs TFSA (which share listings).
function parseEasyEquitiesScreenshot(text, defaultMarket, opts) {
  const lines = String(text || '').replace(/\r/g, '').split('\n')
    .map(s => s.replace(/ /g, ' ').trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const market = eeResolveMarket(eeDetectMarket(lines, defaultMarket), defaultMarket);
  // Broker note and transaction-history rows are checked first: the note's own
  // "SHARES … FSRs" line would otherwise be mistaken for a holding page.
  if (isEEEmailScreenshot(text)) {
    const h = parseEEEmailScreenshot(lines, market);
    return h ? [h] : [];
  }
  if (isEEHistoryScreenshot(text)) {
    const h = parseEEHistoryScreenshot(lines, market);
    return h ? [h] : [];
  }
  if (isEEDetailScreenshot(text)) {
    const h = parseEEDetailScreenshot(lines, market, opts && opts.headerText);
    return h ? [h] : [];
  }
  return parseEEListScreenshot(lines, market);
}

  const api = { configure, YAHOO_EXCHANGE_MAP, parseYahooSymbol, normaliseCompanyName,
    diceSimilarity, companyNameScore, bestNameScore, looksLikeTickerToken,
    rankImportCandidates, IMPORT_SYNONYMS, CURRENCY_TO_MARKET, SUFFIX_TO_MARKET,
    splitTickerMarket, inferMarket, splitLine, splitCsvLine,
    looksLikeHeader, matchColumn, rowsToHoldings, parseImportDate, stripListMarker,
    parseHoldingsFromText, parseEasyEquitiesScreenshot, dedupeEeHoldings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.PBImport = api;
})();
