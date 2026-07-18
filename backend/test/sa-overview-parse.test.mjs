// Tests for parseSAOverviewEarnings (pb-core.js): the stockanalysis.com
// OVERVIEW page-data parser that restores the next-earnings date (Hot Topics
// sweep + stock-card enrichment) after the /api/symbol tree went 404-dead
// (2026-07-12, GAPS.md #18).
//   cd backend/test && node sa-overview-parse.test.mjs
//
// Same SvelteKit __data.json "devalue" transport as the forecast parser (see
// sa-forecast-parse.test.mjs). The overview payload's exact shape isn't
// contract-pinned, so the parser deep-searches every data node for the site's
// own earningsDate key vocabulary and must degrade to null — never throw — on
// anything unrecognised.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBCore from '../../pb-core.js';

const { parseSAOverviewEarnings } = PBCore;

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };

ok('PBCore exports parseSAOverviewEarnings', typeof parseSAOverviewEarnings === 'function');

// ── Synthetic devalue payload builder (same encoding as the forecast test) ──
function devalue(root) {
  const data = [];
  const enc = (v) => {
    if (v === undefined) return -1;
    const i = data.push(null) - 1;
    if (v === null || typeof v !== 'object') data[i] = v;
    else if (Array.isArray(v)) { const a = []; data[i] = a; for (const x of v) a.push(enc(x)); }
    else { const o = {}; data[i] = o; for (const [k, x] of Object.entries(v)) o[k] = enc(x); }
    return i;
  };
  enc(root);
  return data;
}
const saPayload = (overviewRoot) => ({
  type: 'data',
  nodes: [
    { type: 'data', data: devalue({ session: null, theme: 'light' }), uses: {} },
    null,
    { type: 'data', data: devalue({ info: { symbol: 'X', ticker: 'X' } }), uses: {} },
    { type: 'data', data: devalue(overviewRoot), uses: {} }
  ]
});

// ── Hits ────────────────────────────────────────────────────────────────────
const iso = '2026-07-31';
ok('top-level earningsDate string → epoch ms',
  parseSAOverviewEarnings(saPayload({ data: { earningsDate: iso, marketCap: 3.1e12 } })) === Date.parse(iso));
ok('nested deeper (overview.stats) still found',
  parseSAOverviewEarnings(saPayload({ overview: { stats: { earningsDate: iso } } })) === Date.parse(iso));
ok('nextEarningsDate variant accepted',
  parseSAOverviewEarnings(saPayload({ data: { nextEarningsDate: iso } })) === Date.parse(iso));
ok('snake_case variant accepted',
  parseSAOverviewEarnings(saPayload({ data: { earnings_date: iso } })) === Date.parse(iso));
const secs = Math.floor(Date.parse(iso) / 1000);
ok('epoch seconds normalised to ms',
  parseSAOverviewEarnings(saPayload({ data: { earningsDate: secs } })) === secs * 1000);
ok('epoch ms passed through',
  parseSAOverviewEarnings(saPayload({ data: { earningsDate: Date.parse(iso) } })) === Date.parse(iso));
ok('human-readable date string parsed',
  parseSAOverviewEarnings(saPayload({ data: { earningsDate: 'July 31, 2026' } })) === Date.parse('July 31, 2026'));

// ── Misses / defensiveness ──────────────────────────────────────────────────
ok('payload without any earnings key → null',
  parseSAOverviewEarnings(saPayload({ data: { marketCap: 1, peRatio: 20 } })) === null);
ok('unparseable date string → null',
  parseSAOverviewEarnings(saPayload({ data: { earningsDate: 'TBD' } })) === null);
ok('empty string → null',
  parseSAOverviewEarnings(saPayload({ data: { earningsDate: '' } })) === null);
ok('small number (not an epoch) → null',
  parseSAOverviewEarnings(saPayload({ data: { earningsDate: 42 } })) === null);
ok('unrelated key containing "earnings" is not matched',
  parseSAOverviewEarnings(saPayload({ data: { earningsDateHistory: iso, earningsGrowth: 0.2 } })) === null);
ok('empty nodes → null', parseSAOverviewEarnings({ type: 'data', nodes: [] }) === null);
ok('malformed → null, no crash',
  parseSAOverviewEarnings({}) === null && parseSAOverviewEarnings(null) === null &&
  parseSAOverviewEarnings({ type: 'data', nodes: [{ type: 'data', data: 'oops' }] }) === null);
// Depth-bomb: a chain deeper than the search limit must terminate cleanly.
let deep = { earningsDate: iso };
for (let i = 0; i < 20; i++) deep = { wrap: deep };
ok('over-deep nesting degrades to null (bounded search, no hang)',
  parseSAOverviewEarnings(saPayload(deep)) === null);

// ── Source guards: app.js wiring (anti-drift) ───────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
const fnBody = (name) => {
  const start = appSrc.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const rest = appSrc.slice(start + 1);
  const next = rest.search(/\r?\n(?:async )?function /);
  return next < 0 ? rest : rest.slice(0, next);
};
ok('app.js delegates parsing to PBCore.parseSAOverviewEarnings', appSrc.includes('PBCore.parseSAOverviewEarnings('));
const fetcher = fnBody('fetchEarningsDateSA');
ok('fetchEarningsDateSA exists', !!fetcher);
ok('fetcher hits the overview __data.json endpoint (dead /api/symbol tree is gone)',
  !!fetcher && fetcher.includes('/__data.json') && !fetcher.includes('/api/symbol/'));
ok('fetcher rides the proxy chain (endpoint has no ACAO — direct cannot work)',
  !!fetcher && fetcher.includes('fetchViaProxies'));
ok('fetcher is outer-time-boxed so it can never stall the Hot Topics build',
  !!fetcher && fetcher.includes('Promise.race'));
const orch = fnBody('fetchFundamentals');
ok('fetchFundamentals backfills earningsDate from the overview probe',
  !!orch && orch.includes('fetchEarningsDateSA('));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
