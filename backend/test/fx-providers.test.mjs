// Characterization tests for the FX providers (fetchFxRates, fetchHistoricalFx)
// moved out of app.js into pb-data.js — GAPS #7, "the last network code still
// inside app.js". Mocks globalThis.fetch with a scripted response ladder.
//
// These were written BEFORE the move (run against the app.js source slice) and
// the identical matrix now runs against PBData: same 14 outcomes, byte-for-byte.
// They pin the details a rewrite would quietly lose:
//   • the FX ladder is direct-first (entry 0 is the bare url), proxies only after;
//   • fetchFxRates sends cache:'no-store', fetchHistoricalFx cache:'force-cache';
//   • a payload without `result:'success'` is still accepted when `rates` exists;
//   • USD is forced to 1 and the result needs >= 2 rates to count as a hit;
//   • historical lookups try frankfurter fully, then exchangerate.host;
//   • a SUCCESSFUL historical rate is cached, a FAILED one is not.
// FX rates feed convertCcy, so this is money-adjacent code (rule #3).
//   cd backend/test && node fx-providers.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBData from '../../pb-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');
const dataSrc = readFileSync(join(here, '..', '..', 'pb-data.js'), 'utf8');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

// app.js injects DISPLAY_CURRENCIES; pb-data must never reach for it directly.
const DISPLAY_CURRENCIES = [
  { code: 'USD', sym: '$', label: 'US Dollar' },
  { code: 'ZAR', sym: 'R', label: 'South African Rand' },
  { code: 'GBP', sym: '£', label: 'British Pound' },
  { code: 'AUD', sym: 'A$', label: 'Australian Dollar' },
  { code: 'EUR', sym: '€', label: 'Euro' }
];
PBData.configure({ displayCurrencies: DISPLAY_CURRENCIES });

// Scripted fetch: consumes `script` in order; the last entry repeats.
let calls = [];
function installFetch(script) {
  calls = [];
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, cache: opts && opts.cache });
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step === 'throw') throw new Error('network');
    if (step === 'notok') return { ok: false, json: async () => ({}) };
    if (step === 'badjson') return { ok: true, json: async () => { throw new Error('bad json'); } };
    return { ok: true, json: async () => step };
  };
}

// ─── fetchFxRates ───────────────────────────────────────────────────────────
installFetch([{ result: 'success', rates: { USD: 1, ZAR: 18.5, GBP: 0.79, JPY: 155 } }]);
let r = await PBData.fetchFxRates();
eq('fetchFxRates filters to DISPLAY_CURRENCIES (JPY dropped)', r && r.rates, { USD: 1, ZAR: 18.5, GBP: 0.79 });
ok('fetchFxRates reports base + source', r.base === 'USD' && r.source === 'open.er-api.com');
ok('fetchFxRates stamps fetchedAt', typeof r.fetchedAt === 'number' && r.fetchedAt > 0);
eq('fetchFxRates goes direct first (no proxy on the happy path)', calls.map(c => c.url),
  ['https://open.er-api.com/v6/latest/USD']);
ok("fetchFxRates sends cache:'no-store'", calls[0].cache === 'no-store');

installFetch([{ rates: { ZAR: 18.0, EUR: 0.92 } }]);
r = await PBData.fetchFxRates();
eq('fetchFxRates accepts a payload with no result field, forcing USD=1', r && r.rates, { ZAR: 18, EUR: 0.92, USD: 1 });

installFetch(['notok', { result: 'success', rates: { ZAR: 17.1, AUD: 1.5 } }]);
r = await PBData.fetchFxRates();
ok('fetchFxRates falls through to the next proxy on !ok', r && r.rates.ZAR === 17.1);
eq('fetchFxRates ladder order is direct -> corsmirror', calls.map(c => c.url), [
  'https://open.er-api.com/v6/latest/USD',
  'https://corsmirror.com/v1?url=https%3A%2F%2Fopen.er-api.com%2Fv6%2Flatest%2FUSD'
]);

installFetch([{ result: 'success', rates: { JPY: 155 } }]);
r = await PBData.fetchFxRates();
ok('fetchFxRates rejects a single-rate result (needs >= 2) and exhausts the ladder', r === null);
ok('fetchFxRates tries all 4 ladder entries before giving up', calls.length === 4);

installFetch(['throw']);
ok('fetchFxRates returns null when every attempt throws', await PBData.fetchFxRates() === null);
installFetch(['badjson']);
ok('fetchFxRates returns null when the body is not JSON', await PBData.fetchFxRates() === null);

// ─── fetchHistoricalFx ──────────────────────────────────────────────────────
PBData._resetFxCache();
installFetch(['throw']);
ok('fetchHistoricalFx short-circuits USD to 1 without fetching',
  await PBData.fetchHistoricalFx('2026-01-02', 'USD') === 1 && calls.length === 0);
ok('fetchHistoricalFx returns null for a missing date without fetching',
  await PBData.fetchHistoricalFx('', 'ZAR') === null && calls.length === 0);
ok('fetchHistoricalFx returns null for a missing code without fetching',
  await PBData.fetchHistoricalFx('2026-01-02', '') === null && calls.length === 0);

PBData._resetFxCache();
installFetch([{ rates: { ZAR: 18.42 } }]);
ok('fetchHistoricalFx reads the frankfurter endpoint first',
  await PBData.fetchHistoricalFx('2026-01-02', 'ZAR') === 18.42);
eq('fetchHistoricalFx hits frankfurter directly', calls.map(c => c.url),
  ['https://api.frankfurter.app/2026-01-02?from=USD&to=ZAR']);
ok("fetchHistoricalFx sends cache:'force-cache'", calls[0].cache === 'force-cache');

installFetch(['throw']);
ok('a successful historical rate is cached (no re-fetch)',
  await PBData.fetchHistoricalFx('2026-01-02', 'ZAR') === 18.42 && calls.length === 0);

PBData._resetFxCache();
installFetch([{ rates: { ZAR: 0 } }, { rates: { ZAR: -3 } }, { rates: { ZAR: '18' } }, { rates: {} },
              { rates: { ZAR: 19.25 } }]);
ok('fetchHistoricalFx skips zero/negative/non-numeric rates, then falls to exchangerate.host',
  await PBData.fetchHistoricalFx('2026-03-04', 'ZAR') === 19.25);
eq('fetchHistoricalFx exhausts all 4 proxies on endpoint 1 before endpoint 2',
  [calls.length, calls[4].url],
  [5, 'https://api.exchangerate.host/2026-03-04?base=USD&symbols=ZAR']);

PBData._resetFxCache();
installFetch(['notok']);
ok('fetchHistoricalFx returns null when both endpoints fail everywhere',
  await PBData.fetchHistoricalFx('2026-05-06', 'GBP') === null);
ok('fetchHistoricalFx tries 2 endpoints x 4 proxies = 8 attempts', calls.length === 8);
installFetch([{ rates: { GBP: 0.78 } }]);
ok('a FAILED historical lookup is not cached (a retry re-fetches)',
  await PBData.fetchHistoricalFx('2026-05-06', 'GBP') === 0.78 && calls.length === 1);

// ─── Anti-drift guards ──────────────────────────────────────────────────────
for (const fn of ['fetchFxRates', 'fetchHistoricalFx']) {
  ok(`app.js has no local function ${fn}`, !new RegExp(`function\\s+${fn}\\s*\\(`).test(appSrc));
  ok(`app.js binds ${fn} from PBData`, new RegExp(`const\\s+${fn}\\s*=\\s*PBData\\.${fn}`).test(appSrc));
  ok(`pb-data.js defines ${fn}`, new RegExp(`function\\s+${fn}\\s*\\(`).test(dataSrc));
}
ok('app.js no longer declares the FX_PROXIES ladder', !/const\s+FX_PROXIES\s*=/.test(appSrc));
ok('pb-data.js owns the FX_PROXIES ladder', /const\s+FX_PROXIES\s*=/.test(dataSrc));
ok('app.js no longer declares HISTORICAL_FX_CACHE', !/const\s+HISTORICAL_FX_CACHE\s*=/.test(appSrc));
ok('app.js injects displayCurrencies via PBData.configure',
  /PBData\.configure\(\s*\{[^}]*displayCurrencies/.test(appSrc));
ok('pb-data.js reads the injected display currencies, not a global',
  /cfg\.displayCurrencies/.test(dataSrc) && !/PBContent\./.test(dataSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll fx-providers tests passed');
process.exit(failures ? 1 : 0);
