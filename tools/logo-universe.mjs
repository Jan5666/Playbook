// The set of instruments that can appear in a row and therefore needs a mark.
//
// Extracted from build-logos.mjs so the slug harvester resolves EXACTLY the
// same keys the builder will ask for. When these were two copies, a ticker
// could be harvested and never built, or built and never harvested, and the
// only symptom was a silently missing logo.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TV_SLUG } from './logo-tv-ids.mjs';
import { issuerFor } from './logo-sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SECTION_MARKET = {
  HOLDINGS: 'US', NEW_PICKS: 'US', HEDGES: 'US', US_SUGGESTIONS: 'US',
  JSE_SUGGESTIONS: 'JSE', TFSA_SUGGESTIONS: 'TFSA', LSE_SUGGESTIONS: 'LSE',
  ASX_SUGGESTIONS: 'ASX', EU_SUGGESTIONS: 'FRA', CRYPTO_SUGGESTIONS: 'CRYPTO',
};
// Sections that carry no instruments at all. Anything NOT listed in either map
// is a hard error: a new *_SUGGESTIONS block must state its market, or it would
// be silently routed down the US bare-ticker path and mislabel every mark.
const NON_INSTRUMENT = new Set([
  'DEPLOYMENT_PHASES', 'RISKS', 'PILLARS', 'HEATMAPS', 'MACRO', 'CALENDAR',
  'SECTOR_CANON',
]);

// Instruments an owner can hold that data.js never lists. data.js is a
// suggestions catalogue, not an inventory — Bittensor was held and charted with
// a hashed-letter monogram purely because no suggestion row happened to mention
// it. Anything added here gets a mark without becoming an in-app suggestion.
export const SUPPLEMENTAL = [
  // Large-cap coins absent from CRYPTO_SUGGESTIONS.
  { market: 'CRYPTO', ticker: 'TAO' },   // Bittensor
  { market: 'CRYPTO', ticker: 'DOT' },
  { market: 'CRYPTO', ticker: 'FET' },   // Artificial Superintelligence Alliance
  { market: 'CRYPTO', ticker: 'RUNE' },  // THORChain
  { market: 'CRYPTO', ticker: 'KAS' },   // Kaspa
  { market: 'CRYPTO', ticker: 'JUP' },   // Jupiter
  { market: 'CRYPTO', ticker: 'ONDO' },
  { market: 'CRYPTO', ticker: 'WLD' },   // Worldcoin
  { market: 'CRYPTO', ticker: 'LDO' },   // Lido DAO
  { market: 'CRYPTO', ticker: 'ENA' },   // Ethena
  { market: 'CRYPTO', ticker: 'BONK' },
  { market: 'CRYPTO', ticker: 'WIF' },   // dogwifhat
  { market: 'CRYPTO', ticker: 'FLOKI' },
  { market: 'CRYPTO', ticker: 'GALA' },
  { market: 'CRYPTO', ticker: 'CRV' },   // Curve DAO
  { market: 'CRYPTO', ticker: 'SNX' },   // Synthetix
  { market: 'CRYPTO', ticker: 'COMP' },  // Compound
  { market: 'CRYPTO', ticker: 'CAKE' },  // PancakeSwap
  { market: 'CRYPTO', ticker: 'EGLD' },  // MultiversX
  { market: 'CRYPTO', ticker: 'FLOW' },
  { market: 'CRYPTO', ticker: 'CHZ' },   // Chiliz
  { market: 'CRYPTO', ticker: 'ENS' },
  { market: 'CRYPTO', ticker: 'ZEC' },   // Zcash
  { market: 'CRYPTO', ticker: 'DASH' },
  { market: 'CRYPTO', ticker: 'NEO' },
  { market: 'CRYPTO', ticker: 'VET' },   // VeChain
  { market: 'CRYPTO', ticker: 'THETA' },
  { market: 'CRYPTO', ticker: 'AR' },    // Arweave
  { market: 'CRYPTO', ticker: 'JASMY' },
  { market: 'CRYPTO', ticker: 'PYTH' },
  { market: 'CRYPTO', ticker: 'STRK' },  // Starknet
  { market: 'CRYPTO', ticker: 'BLUR' },
  { market: 'CRYPTO', ticker: 'AERO' },  // Aerodrome
  { market: 'CRYPTO', ticker: 'MOVE' },  // Movement
];

export function loadData() {
  const g = { window: {} };
  const src = readFileSync(join(ROOT, 'data.js'), 'utf8');
  new Function('window', src)(g.window);
  return g.window.PB_DATA;
}

// Returns [{ ticker, market, key }]. `backupPath` folds in the owner's real
// positions and watchlist, which is the only way a held-but-unlisted instrument
// can be seen at all.
export function collectUniverse({ backupPath = null } = {}) {
  const D = loadData();
  const set = new Map(); // 'MARKET:TICKER' -> { ticker, market }
  const add = (ticker, market) => {
    if (!ticker || !market || !/^[A-Z0-9][A-Z0-9.\-]*$/i.test(ticker)) return;
    set.set(`${market}:${ticker}`, { ticker, market });
  };
  for (const [name, val] of Object.entries(D)) {
    if (name === '_US_SECTORS') continue;
    if (!Array.isArray(val)) continue;
    if (NON_INSTRUMENT.has(name)) continue;
    const market = SECTION_MARKET[name];
    if (!market) {
      throw new Error(`data.js section ${name} has no market in SECTION_MARKET — ` +
        'add it there (or to NON_INSTRUMENT), otherwise every ticker in it is ' +
        'treated as US and resolves another company\'s logo.');
    }
    // EU_SUGGESTIONS spans three venues and says which on each row; the app
    // stores that value as the holding's market, so the manifest key must use it.
    for (const row of val) if (row && row.ticker) add(row.ticker, row.exchange || market);
  }
  // The curated sector maps are the real breadth of the app: any of these can be
  // typed into search, so any of them can appear in a row that needs a mark.
  for (const t of Object.keys(D._US_SECTORS || {})) add(t, 'US');
  // _INTL_SECTORS is already keyed MARKET:TICKER in the app's own market codes.
  for (const k of Object.keys(D._INTL_SECTORS || {})) {
    const i = k.indexOf(':');
    if (i > 0) add(k.slice(i + 1), k.slice(0, i));
  }
  // The heatmap blocks carry `t:` inside `constituents`, and each grid names its
  // own market — the FTSE/JSE/DAX grids are not US.
  for (const grid of D.HEATMAPS || []) {
    for (const row of grid.constituents || []) if (row && row.t) add(row.t, grid.market || 'US');
  }
  for (const s of SUPPLEMENTAL) add(s.ticker, s.market);
  // Everything the slug harvest covers. tv-harvest.mjs applies a per-venue
  // listing policy (the whole JSE board, every UK share and investment trust),
  // so this is what lifts the universe off data.js — which is a suggestions
  // catalogue and was never an inventory of what an owner can hold. Scottish
  // Mortgage and Bittensor were both "missing a logo" purely because no
  // suggestion row happened to name them.
  for (const key of Object.keys(TV_SLUG)) {
    const i = key.indexOf(':');
    if (i > 0) add(key.slice(i + 1), key.slice(0, i));
  }
  // Every SA managed fund is holdable in a tax-free account, so each JSE fund
  // gets its TFSA twin. The harvester mirrors what the exchange still lists as
  // `fund/etf`, which misses 18 ranges it has since retyped or delisted
  // (NFSWIX, STX100, SYGGLD, the CoreShares CS* line...). issuerFor() is the
  // app's OWN definition of "this is an SA managed fund", so using it here keeps
  // the two markets from drifting apart again.
  for (const { ticker, market } of [...set.values()]) {
    if (market === 'JSE' && issuerFor(ticker)) add(ticker, 'TFSA');
  }
  if (backupPath) {
    const raw = JSON.parse(readFileSync(backupPath, 'utf8'));
    const keys = raw.keys || raw;
    const parse = (k) => { try { return JSON.parse(keys[k]); } catch { return []; } };
    for (const p of parse('pb.positions.v1') || []) add(p.ticker, p.market);
    for (const w of parse('pb.watchlist.v1') || []) add(w.ticker, w.market);
  }
  return [...set.values()].map(v => ({ ...v, key: `${v.market}:${v.ticker}` }));
}
