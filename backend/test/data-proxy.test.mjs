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

// ── An upstream envelope is an ANSWER, not a proxy fault ────────────────────
// Yahoo reports a symbol it does not have as {"chart":{"result":null,"error":{…}}}.
// The generic `"error":` clause matched that, so a dead ticker was indistinguishable
// from a flaky edge and burned ALL SIX proxies — twice per sweep, because
// fetchQuoteBatch retries the misses. ~12 wasted round-trips per poll for one bad
// symbol, spent on the same shared free proxies the rest of the sweep needs, which
// is how one unresolvable holding starts costing the others their quotes.
const YAHOO_404 = '{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}';
ok('yahoo not-found envelope is NOT a proxy error', PBData.looksLikeProxyError(YAHOO_404) === false);
ok('yahoo envelope with leading whitespace is still recognised',
  PBData.looksLikeProxyError('  \n' + YAHOO_404) === false);
ok('quoteSummary envelope is NOT a proxy error',
  PBData.looksLikeProxyError('{"quoteSummary":{"result":null,"error":{"code":"Not Found"}}}') === false);
// …and the generic clause still catches a proxy's OWN error json, which is the
// case it was written for. Non-vacuous: both bodies contain `"error":`.
ok('a proxy\'s own error json is still an error',
  PBData.looksLikeProxyError('{"error":"rate limited, try again later"}') === true);
ok('the two bodies really are distinguished only by the envelope',
  /"error"\s*:/.test(YAHOO_404) && /"error"\s*:/.test('{"error":"rate limited, try again later"}'));

// End to end: a not-found body stops the ladder at the FIRST proxy instead of
// walking all six, and hands the envelope back for the parser to reject.
PBData._setLastGoodProxy(null);
let ladder = 0;
globalThis.fetch = async () => { ladder++; return { ok: true, text: async () => YAHOO_404 }; };
const nf = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/v8/finance/chart/NOPE.JO');
ok('not-found: body returned to the caller, not swallowed', nf === YAHOO_404);
ok('not-found: only one proxy tried, not the whole ladder', ladder === 1, `tried ${ladder}`);

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

// ── CIRCUIT BREAKER: the ladder must remember FAILURE, not just success ──────
// lastGoodProxy promotes winners and never demotes losers. That asymmetry meant a
// dead edge sat at the front (or, once something else won, at position 1) and was
// re-tried for its full deadline on every request for the life of the session.
// Measured on a 200-url sweep with a stalling lead rung: 11.1s -> 8.1s, and with
// only the last rung alive, 35.1s -> 26.0s.
const OKBODY = '{"chart":{"result":[{"meta":{}}]}}';

PBData._resetProxyHealth();
PBData._setProxyBreakerConfig({ trip: 2, cooldownMs: 400, maxMs: 800, probeMs: 60, budgetMs: 5000 });

// One failure demotes nothing yet (a single blip must not cost a good provider).
installFetch([{ match: 'corsmirror', ok: false }, { match: 'cors.lol', body: OKBODY }]);
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/brk1');
let snap = PBData.proxyHealthSnapshot(Date.now());
const cm = () => PBData.proxyHealthSnapshot(Date.now()).find(p => p.provider === 'corsmirror');
ok('breaker: one failure is recorded but does not open', cm().fails === 1 && cm().state === 'failing');
ok('breaker: the winner is marked last-good', snap.find(p => p.provider === 'cors.lol').isLastGood === true);

// A demoted rung is only re-tried when it is CHOSEN again, so a second failure
// needs the winner to stop leading — which is exactly what happens when the proxy
// that was carrying the feed goes away and corsmirror returns to the front.
PBData._setLastGoodProxy(null);
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/brk2');
ok('breaker: two failures open the penalty box', cm().state === 'penalised' && cm().openForMs > 0);

// ...and an open breaker moves that provider to the BACK of the ladder.
const order = PBData.orderedProxies(Date.now()).map(p => p.name);
ok('breaker: a penalised provider is demoted to last', order[order.length - 1] === 'corsmirror');
ok('breaker: the last winner leads the healthy group', order[0] === 'cors.lol');

// A penalised provider is DEMOTED, never dropped: if every rung is in the box the
// ladder must still walk them all rather than resolve null without trying.
PBData._resetProxyHealth();
const allBadCalls = installFetch([{ match: 'zzz-nothing-matches', body: OKBODY }]);
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/allbad1');
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/allbad2');
const before = allBadCalls.length;
const res = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/allbad3');
ok('breaker: every provider penalised still walks the whole ladder', allBadCalls.length - before >= 6);
ok('breaker: ...and resolves null, not a body', res === null);

// The two allorigins rungs are ONE provider: an outage must cost one provider's
// worth of trust, not two rungs'.
PBData._resetProxyHealth();
installFetch([{ match: 'allorigins', ok: false }, { match: 'codetabs', body: OKBODY }]);
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/ao1');
const ao = PBData.proxyHealthSnapshot(Date.now()).filter(p => p.provider === 'allorigins');
ok('breaker: allorigins-get and -raw share one breaker record', ao.length === 1);
ok('breaker: ...and one walk counts both its rungs', ao[0].fails === 2 && ao[0].state === 'penalised');

// The cooldown expires and the provider is rehabilitated.
PBData._resetProxyHealth();
PBData._setProxyBreakerConfig({ trip: 1, cooldownMs: 60, maxMs: 60, probeMs: 60, budgetMs: 5000 });
installFetch([{ match: 'corsmirror', ok: false }, { match: 'cors.lol', body: OKBODY }]);
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/cool1');
ok('breaker: tripped at the configured threshold', cm().state === 'penalised');
await new Promise(r => setTimeout(r, 120));
ok('breaker: cooldown expires on its own', cm().state !== 'penalised');

// THE SLOW-PROXY TRAP. An unproven rung runs on the short probe deadline, so a
// merely-slow-but-working proxy could be clipped at the probe forever, never earn a
// full budget, and be demoted for being slow. The first TIMEOUT therefore only buys
// that rung the caller's full timeoutMs next time; it does not count toward the trip.
PBData._resetProxyHealth();
PBData._setProxyBreakerConfig({ trip: 2, cooldownMs: 5000, maxMs: 5000, probeMs: 40, budgetMs: 5000 });
let attempts = 0;
globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
  if (!String(url).includes('corsmirror')) return resolve({ ok: false, text: async () => '' });
  attempts++;
  const wait = 120;                      // slower than the 40ms probe, faster than the 400ms budget
  const timer = setTimeout(() => resolve({ ok: true, text: async () => OKBODY }), wait);
  if (init && init.signal) init.signal.addEventListener('abort', () => {
    clearTimeout(timer); const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
  });
});
await PBData.fetchViaProxies('https://query1.finance.yahoo.com/slow1', { timeoutMs: 400 });
ok('slow proxy: a timeout does not count toward the trip', cm().fails === 0);
const slowBody = await PBData.fetchViaProxies('https://query1.finance.yahoo.com/slow2', { timeoutMs: 400 });
ok('slow proxy: its next attempt gets the FULL deadline and succeeds', slowBody === OKBODY);
ok('slow proxy: ...so it is never demoted for being slow', cm().state === 'ok');

// Restore the shipped constants so any later suite in the same process is honest.
PBData._setProxyBreakerConfig(null);
PBData._resetProxyHealth();

// Anti-drift: the rung must be chosen AFTER the limiter admits the attempt. Picking
// before queueing means every member of a burst commits to the same rung before any
// of them has learned it is dead — and made the whole-ladder budget measure QUEUE
// time, which measured 0 of 200 urls resolved.
const dataSrcBreaker = readFileSync(join(here, '..', '..', 'pb-data.js'), 'utf8');
ok('pb-data picks the rung inside the limiter',
  /_fetchLimit\(async \(\) => \{[\s\S]{0,400}nextProxy\(tried/.test(dataSrcBreaker));
ok('pb-data budgets ATTEMPT time, not wall clock',
  /spent \+= step\.spent/.test(dataSrcBreaker) && !/Date\.now\(\) - startedAt >= LADDER_BUDGET_MS/.test(dataSrcBreaker));
ok('pb-data records a failure at every ladder exit',
  (dataSrcBreaker.match(/noteProxyFail\(/g) || []).length >= 4);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll data-proxy tests passed');
process.exit(failures ? 1 : 0);
