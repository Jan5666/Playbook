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

// Anti-drift guard
ok('app.js binds fetchViaProxies from PBData', /const\s+fetchViaProxies\s*=\s*PBData\.fetchViaProxies/.test(appSrc));
ok('app.js has no local function fetchViaProxies', !/function\s+fetchViaProxies\s*\(/.test(appSrc));

console.log(failures ? `\n${failures} test(s) failed` : '\nAll data-proxy tests passed');
process.exit(failures ? 1 : 0);
