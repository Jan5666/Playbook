// Harvest the ticker -> logo-slug map from TradingView's public screener and
// emit tools/logo-tv-ids.mjs.
//
//   node tools/tv-harvest.mjs [--no-cache]
//
// WHY A HARVESTER AND NOT A LIVE LOOKUP
// The logo CDN is keyed by a curated slug ("capitec-bank-holdings"), not by a
// ticker, so nothing here can repeat the bare-ticker mistake that made MTN
// resolve to Vail Resorts: the slug is chosen by asking the screener for ONE
// EXCHANGE at a time, so JSE:SOL can only ever come back as Sasol's slug and
// never as ReneSola's. The generated file pins the answer, and every row
// carries the exchange's own description as a comment, which is what makes the
// map checkable by eye — the acceptance gate for this pack is a human, and a
// bare slug list would not be reviewable.
//
// Re-run this only to pick up newly listed instruments. The emitted file is
// committed; build-logos.mjs reads it and never calls the screener itself.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectUniverse } from './logo-universe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.logo-cache');
const NO_CACHE = process.argv.includes('--no-cache');

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  'content-type': 'text/plain;charset=UTF-8',
  origin: 'https://www.tradingview.com',
  referer: 'https://www.tradingview.com/',
};

// What an instrument IS, as the screener describes it: `type` plus the first
// entry of `typespecs`. Scottish Mortgage is `fund/closedend`, Vodacom is
// `stock/common`, a Satrix tracker is `fund/etf`.
const kindOf = (row) => `${row.d[3]}/${(row.d[4] || [])[0] || ''}`;

// market -> the screener region + exchange that lists it. TFSA is not an
// exchange: a tax-free account holds JSE-listed instruments, so it reuses JSE.
//
// `cover` is the LISTING policy: which rows get a slug even though no data.js
// section mentions them. Rows named by data.js are always covered — this is
// purely about breadth beyond the suggestions catalogue.
//
// Why breadth is needed at all: data.js is a suggestions catalogue, not an
// inventory of what can be held. Bittensor and Scottish Mortgage were both
// reported as "missing a logo" for the same reason — nothing was wrong with the
// pipeline, the instruments were simply never in the universe it built.
const ALL_EQUITY = new Set(['stock/common', 'stock/preferred', 'dr/']);
const VENUES = [
  // US breadth already comes from data.js's 1412-entry _US_SECTORS map.
  { market: 'US', region: 'america', exchanges: ['NASDAQ', 'NYSE', 'AMEX'] },
  // The whole JSE board: 244 shares, 216 SA ETFs, 3 prefs. It is small enough
  // that covering it completely is cheaper than fielding one gap at a time.
  { market: 'JSE', region: 'rsa', exchanges: ['JSE'], cover: () => true },
  // A South African TFSA may hold collective schemes, not single shares, so the
  // tax-free mirror of the JSE board is its ETFs.
  { market: 'TFSA', region: 'rsa', exchanges: ['JSE'], cover: r => kindOf(r) === 'fund/etf' },
  // Every UK share, depositary receipt and investment trust. The trusts are the
  // point: `fund/closedend` is what SMT, FCIT and RIT are, and UK retail
  // portfolios are full of them.
  //
  // The LSE's 4836 `fund/etf` rows are deliberately EXCLUDED. They are mostly
  // foreign-domiciled UCITS lines carrying just 72 distinct issuer marks between
  // them, so they would add thousands of manifest rows to a file the app parses
  // at every cold start in exchange for ~72 tiles. Add 'fund/etf' to the set
  // below if that ever becomes worth it.
  {
    market: 'LSE',
    region: 'uk',
    exchanges: ['LSE'],
    cover: r => ALL_EQUITY.has(kindOf(r)) || kindOf(r) === 'fund/closedend',
  },
  { market: 'ASX', region: 'australia', exchanges: ['ASX'] },
  { market: 'FRA', region: 'germany', exchanges: ['XETR'] },
  { market: 'PAR', region: 'france', exchanges: ['EURONEXT'] },
  { market: 'AMS', region: 'netherlands', exchanges: ['EURONEXT'] },
];

const PAGE = 2000;

async function scanPage(region, exchange, from, to) {
  const body = JSON.stringify({
    filter: [{ left: 'exchange', operation: 'equal', right: exchange }],
    columns: ['name', 'description', 'logoid', 'type', 'typespecs'],
    // A sort is NOT cosmetic here. Without one the screener's row order is not
    // stable between calls, so paging through it returns some rows twice and
    // others never — the first harvest silently missed QQQ, ARKK and GLEN while
    // reporting 14000 rows scanned against a true total of 10690. Sorting on a
    // unique-ish column makes the window deterministic.
    sort: { sortBy: 'name', sortOrder: 'asc' },
    range: [from, to],
  });
  return post(region, body, body);
}

async function post(region, body, cacheKey) {
  const cp = join(CACHE, 'tv-' + createHash('sha1').update(region + '|' + cacheKey).digest('hex') + '.json');
  if (!NO_CACHE && existsSync(cp)) return JSON.parse(readFileSync(cp, 'utf8'));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  const r = await fetch(`https://scanner.tradingview.com/${region}/scan`, {
    method: 'POST', body, headers: HEADERS, signal: ctl.signal,
  });
  clearTimeout(t);
  if (!r.ok) throw new Error(`${region} HTTP ${r.status}`);
  const j = await r.json();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cp, JSON.stringify(j));
  return j;
}

async function scanAll(region, exchange) {
  const rows = [];
  const first = await scanPage(region, exchange, 0, PAGE);
  const total = first.totalCount || 0;
  rows.push(...(first.data || []));
  for (let from = PAGE; from < total; from += PAGE) {
    const j = await scanPage(region, exchange, from, from + PAGE);
    rows.push(...(j.data || []));
  }
  return rows;
}

// The app and the exchange do not always spell a ticker the same way: the LSE
// writes BT.A and Aviva as AV., the app stores BT-A and AV. Compare on a
// stripped form so those still match, and keep the app's spelling as the key.
const norm = (t) => String(t).toUpperCase().replace(/[.\-_ ]/g, '');

// Where punctuation-stripping is not enough because the instrument was RENAMED.
// Our key stays the ticker the owner holds it under; the value is what the venue
// calls it today. Kept explicit rather than fuzzy-matched on the description: a
// fuzzy match here would silently pair two different coins.
const VENUE_SYMBOL = {
  'CRYPTO:RNDR': 'RENDER', // Render rebranded from RNDR to RENDER in 2024
};

const universe = collectUniverse();
const wanted = new Map(); // market -> Map(normTicker -> key)
for (const u of universe) {
  if (!wanted.has(u.market)) wanted.set(u.market, new Map());
  wanted.get(u.market).set(norm(VENUE_SYMBOL[u.key] || u.ticker), u.key);
}

const out = new Map(); // key -> { slug, desc, type }
const venueStats = [];

for (const v of VENUES) {
  const want = wanted.get(v.market);
  if (!want) continue;
  let seen = 0, hit = 0;
  for (const ex of v.exchanges) {
    let rows;
    try { rows = await scanAll(v.region, ex); } catch (e) { console.error(`  ${v.market} ${ex}: ${e.message}`); continue; }
    seen += rows.length;
    for (const row of rows) {
      const [name, desc, logoid] = row.d || [];
      if (!name || !logoid) continue;
      // A row earns a slug either because data.js names it, or because this
      // venue's listing policy covers it.
      const listed = String(name).toUpperCase();
      const key = want.get(norm(name))
        || (v.cover && v.cover(row) && /^[A-Z0-9][A-Z0-9.\-]*$/.test(listed)
          ? `${v.market}:${listed}` : null);
      if (!key) continue;
      // First exchange to answer wins: the venue list is ordered by how likely
      // the primary listing is to sit there, and a dual-listed line would
      // otherwise flip depending on scan order.
      if (out.has(key)) continue;
      out.set(key, { slug: logoid, desc: String(desc || '').replace(/\s+/g, ' ').trim() });
      hit++;
    }
  }
  venueStats.push({ market: v.market, scanned: seen, matched: hit, universe: want.size });
}

// ─── Crypto ─────────────────────────────────────────────────────────────────
// A different endpoint and a different column: a coin is not listed on an
// exchange, so `logoid` is empty and the slug lives in `base_currency_logoid`.
// Sorted by market cap DESCENDING and first-match-wins, because ticker symbols
// collide across coins far more than equity tickers do — several dead tokens
// carry the symbol of a live one, and the owner always means the big one.
{
  const want = wanted.get('CRYPTO');
  if (want) {
    const body = JSON.stringify({
      columns: ['base_currency', 'base_currency_desc', 'base_currency_logoid', 'market_cap_calc'],
      sort: { sortBy: 'market_cap_calc', sortOrder: 'desc' },
      range: [0, 5000],
    });
    let rows = [];
    try { rows = (await post('coin', body, 'coin-mcap-5000')).data || []; } catch (e) { console.error('  crypto:', e.message); }
    let hit = 0;
    for (const row of rows) {
      const [sym, desc, slug] = row.d || [];
      if (!sym || !slug) continue;
      const key = want.get(norm(sym));
      if (!key || out.has(key)) continue;
      out.set(key, { slug, desc: String(desc || '').replace(/\s+/g, ' ').trim() });
      hit++;
    }
    venueStats.push({ market: 'CRYPTO', scanned: rows.length, matched: hit, universe: want.size });
  }
}

console.table(venueStats);

const lines = [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([k, v]) => {
    const desc = v.desc.replace(/\*\//g, '').slice(0, 46);
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v.slug)},${desc ? ` // ${desc}` : ''}`;
  });

const header = `// GENERATED by tools/tv-harvest.mjs — do not hand-edit; re-run the harvester.
//
// MARKET:TICKER -> TradingView's curated logo slug, plus the listing's own
// description so a human can check the row without leaving the file. The slug
// is fetched from the CDN as \`<slug>--big.svg\` (a vector, so it rasterises
// crisp at any size — that is what this source is FOR: the SA and UK corporate
// sites that fed the old pipeline publish nothing larger than a 32x32 favicon).
//
// Every row was resolved by asking the screener for ONE exchange, so a ticker
// can only ever carry its own venue's company. That is the same guarantee the
// domain rule gives, which is why this is allowed to key non-US markets.
export const TV_SLUG = {
`;

writeFileSync(join(ROOT, 'tools', 'logo-tv-ids.mjs'), header + lines.join('\n') + '\n};\n');
console.log(`\nwrote tools/logo-tv-ids.mjs — ${out.size} slugs`);
