// Characterization tests for the CORS proxy ladder moved into pb-data.js
// (fetchViaProxies + looksLikeProxyError + orderedProxies / lastGoodProxy float).
//   cd backend/test && node data-proxy.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PBData from '../../pb-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', '..', 'app.js'), 'utf8');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`); if (!cond) failures++; };

// Minimal fetch mock: each entry maps a substring → { ok, body }. Records calls.
function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (proxiedUrl) => {
    calls.push(proxiedUrl);
    for (const r of routes) {
      if (proxiedUrl.includes(r.match)) {
        if (r.throw) throw new Error('network');
        return { ok: r.ok !== false, text: async () => r.body, json: async () => JSON.parse(r.body) };
      }
    }
    return { ok: false, text: async () => '', json: async () => ({}) };
  };
  return calls;
}

// looksLikeProxyError classification
ok('exports looksLikeProxyError', typeof PBData.looksLikeProxyError === 'function');
ok('short body is error', PBData.looksLikeProxyError('x') === true);
ok('html body is error', PBData.looksLikeProxyError('<!DOCTYPE html><html>...</html>') === true);
ok('rate-limit phrase is error', PBData.looksLikeProxyError('xxxxxxxxxxxxxxxxxxxxxx Too Many Requests xxxxx') === true);
ok('clean json body is ok', PBData.looksLikeProxyError('{"chart":{"result":[{"meta":{"x":1}}]}}') === false);

// fetchViaProxies returns the first clean body and floats lastGoodProxy
PBData._setLastGoodProxy(null);
let calls = installFetch([{ match: 'finance.yahoo.com', body: '{"ok":true,"padding":"aaaaaaaaaaaaaaaaaaaa"}' }]);
let body = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/v8/finance/chart/AAPL');
ok('fetchViaProxies returns clean body', body === '{"ok":true,"padding":"aaaaaaaaaaaaaaaaaaaa"}');
ok('fetchViaProxies set lastGoodProxy', PBData._lastGoodProxy != null);

// First proxy returns an error body → falls through to the next proxy
PBData._setLastGoodProxy(null);
let n = 0;
globalThis.fetch = async (u) => {
  n++;
  // first call: rate-limited error body; second call: clean body
  return { ok: true, text: async () => (n === 1 ? 'Too Many Requests ........................' : '{"good":true,"padding":"aaaaaaaaaaaaaaaaaaaa"}') };
};
body = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/x');
ok('fetchViaProxies falls through error body to next proxy', body === '{"good":true,"padding":"aaaaaaaaaaaaaaaaaaaa"}' && n === 2);

// All proxies fail → null
globalThis.fetch = async () => ({ ok: false, text: async () => '' });
body = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/y');
ok('fetchViaProxies all-fail → null', body === null);

// ── in-flight de-dupe: two concurrent same-url calls → one underlying fetch ──
PBData._setLastGoodProxy(null);
let hits = 0;
globalThis.fetch = async () => { hits++; await new Promise(r => setTimeout(r, 15)); return { ok: true, text: async () => '{"x":1,"padding":"aaaaaaaaaaaaaaaaaaaa"}' }; };
let [a, b] = await Promise.all([
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/dedupe'),
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/dedupe')
]);
ok('de-dupe: both callers get the same body', a === b && a === '{"x":1,"padding":"aaaaaaaaaaaaaaaaaaaa"}');
ok('de-dupe: only one underlying fetch', hits === 1);

// different urls (e.g. cacheBust) are NOT de-duped
hits = 0;
await Promise.all([
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/x?_=1'),
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/x?_=2')
]);
ok('de-dupe: distinct urls each fetch', hits === 2);

// after settle the entry is freed (a later call refetches)
hits = 0;
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/again');
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/again');
ok('de-dupe: map cleared after settle', hits === 2);

// ── limiter: peak concurrent fetch() never exceeds the cap ───────────────────
let active = 0, peak = 0;
globalThis.fetch = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--; return { ok: true, text: async () => '{"ok":1,"padding":"aaaaaaaaaaaaaaaaaaaa"}' }; };
await Promise.all(Array.from({ length: 20 }, (_, i) => PBData.fetchViaProxies('https://query1.finance.yahoo.com/cap' + i)));
ok('limiter: peak concurrent fetch ≤ 8', peak <= 8 && peak > 0);

// ── STALLED BODY: the deadline must cover res.text(), not just the headers ───
// The failure this pins is not "slow" — it is UNBOUNDED. A proxy that returns
// headers and then never finishes the body used to hang forever, because the
// abort timer was cleared the moment fetch() resolved and the body was read
// outside any deadline. One stall then wedged three things at once, all of them
// permanent for the life of the page:
//   • the _inflight entry for that url (the auto-poll url is byte-identical
//     every poll — no cacheBust — so that symbol could never be fetched again);
//   • fetchQuoteBatch's Promise.allSettled, hence usePriceFeed's runFetch;
//   • loadingRef, which makes the manual refresh button a silent no-op.
// A faithful mock must honour the abort signal, because that is exactly what a
// real Response.text() does — it rejects with AbortError when the controller
// fires. With the timer alive across the body read, the ladder simply moves on.
function stallingBody(signal) {
  return new Promise((_resolve, reject) => {
    if (!signal) return;                       // no signal → hangs, as it used to
    if (signal.aborted) return reject(new Error('AbortError'));
    signal.addEventListener('abort', () => reject(new Error('AbortError')));
  });
}
const CLEAN = '{"good":true,"padding":"aaaaaaaaaaaaaaaaaaaa"}';

PBData._setLastGoodProxy(null);
let stalls = 0;
globalThis.fetch = async (_u, opts) => {
  stalls++;
  return { ok: true, text: () => stallingBody(opts && opts.signal) };
};
let t0 = Date.now();
let stalled = await Promise.race([
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/stall', { timeoutMs: 150 }),
  new Promise(r => setTimeout(() => r('HUNG'), 4000))
]);
ok('stalled body: settles instead of hanging forever', stalled !== 'HUNG');
ok('stalled body: all proxies tried, returns null', stalled === null && stalls === 6);
ok('stalled body: honours the deadline (not the 4s guard)', Date.now() - t0 < 3000);

// …and the in-flight entry must be freed, or that url is dead for the session.
stalls = 0;
globalThis.fetch = async () => ({ ok: true, text: async () => CLEAN });
let afterStall = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/stall', { timeoutMs: 150 });
ok('stalled body: _inflight freed, same url refetches', afterStall === CLEAN && stalls === 0);

// A stall on the FIRST proxy must fall through to the next one, not abort the sweep.
PBData._setLastGoodProxy(null);
let idx = 0;
globalThis.fetch = async (_u, opts) => {
  idx++;
  if (idx === 1) return { ok: true, text: () => stallingBody(opts && opts.signal) };
  return { ok: true, text: async () => CLEAN };
};
body = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/stall2', { timeoutMs: 150 });
ok('stalled body: ladder falls through to the next proxy', body === CLEAN && idx === 2);

// The concurrency slot must be released too — a stalled body must not permanently
// consume one of the 8 shared slots (that would starve every other provider).
PBData._setLastGoodProxy(null);
globalThis.fetch = async (u, opts) => (u.includes('slot-stall')
  ? { ok: true, text: () => stallingBody(opts && opts.signal) }
  : { ok: true, text: async () => CLEAN });
const stallers = Array.from({ length: 8 }, (_, i) =>
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/slot-stall' + i, { timeoutMs: 150 }));
const passenger = await Promise.race([
  PBData.fetchViaProxies('https://query1.finance.yahoo.com/passenger', { timeoutMs: 150 }),
  new Promise(r => setTimeout(() => r('STARVED'), 4000))
]);
ok('stalled body: releases its limiter slot', passenger === CLEAN);
await Promise.all(stallers);

// Anti-drift guard
ok('app.js binds fetchViaProxies from PBData', /const\s+fetchViaProxies\s*=\s*PBData\.fetchViaProxies/.test(appSrc));
ok('app.js has no local function fetchViaProxies', !/function\s+fetchViaProxies\s*\(/.test(appSrc));
// The body read must sit INSIDE the deadline. Pinning the source shape as well as
// the behaviour, because a future refactor that hoists res.text() back out would
// still pass every behavioural test above on a mock that resolves quickly.
const dataSrcProxy = readFileSync(join(here, '..', '..', 'pb-data.js'), 'utf8');
ok('pb-data reads the body through the deadline helper',
  /fetchWithDeadline/.test(dataSrcProxy) && !/const\s+text\s*=\s*await\s+res\.text\(\)/.test(dataSrcProxy));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll data-proxy tests passed');
process.exit(failures ? 1 : 0);
