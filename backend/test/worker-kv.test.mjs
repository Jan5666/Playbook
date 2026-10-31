// Worker storage behaviour under a mocked KV + fetch (2026-10-31 bug sweep).
//   node backend/test/worker-kv.test.mjs
//  1. a failed KV write is NOT reported as success (/backup -> 503), and the cron
//     does not push a crossing whose seen-state failed to persist (it used to
//     push the same crossing every minute);
//  2. the cron re-reads the record before writing, so an alert added by /sync
//     while the cron was fetching quotes survives;
//  3. alert notifications use the market's own currency symbol.
import worker from '../worker.js';
import { bytesToB64url } from '../webpush.js';

let failures = 0;
const ok = (n, c, got) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${c ? '' : '  — got ' + JSON.stringify(got)}`); if (!c) failures++; };

const s = crypto.subtle;
const vk = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const VAPID_PUBLIC = bytesToB64url(new Uint8Array(await s.exportKey('raw', vk.publicKey)));
const VAPID_PRIVATE = (await s.exportKey('jwk', vk.privateKey)).d;
const ck = await s.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const subscription = { endpoint: 'https://push.example/x', keys: {
  p256dh: bytesToB64url(new Uint8Array(await s.exportKey('raw', ck.publicKey))),
  auth: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))) } };
const A = (id, t, market = 'CRYPTO', ticker = 'BTC') => ({ id, ticker, market, direction: 'above', targetPrice: t, active: true, note: '' });

function mkEnv(rec, { failPut = false } = {}) {
  const store = new Map([['client:dev1', JSON.stringify(rec)]]);
  const PB = {
    async get(k) { const v = store.get(k); return v == null ? null : JSON.parse(v); },
    async put(k, v) { if (env.failPut) throw new Error('KV put() limit exceeded for the day.'); store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [...store.keys()].filter(k => k.startsWith('client:')).map(name => ({ name })), list_complete: true }; },
  };
  const env = { PB, VAPID_PUBLIC, VAPID_PRIVATE, failPut, store };
  return env;
}
const cron = async (env) => { const ps = []; await worker.scheduled({}, env, { waitUntil: p => ps.push(p) }); await Promise.all(ps); };
const quote = (px, currency = 'USD') => new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: px, currency } }] } }), { status: 200 });

// 1. KV writes failing
{
  const env = mkEnv({ subscription, alerts: [A('a1', 100)], seen: {}, updatedAt: Date.now(), lastActiveAt: 0 }, { failPut: true });
  let pushes = 0;
  globalThis.fetch = async (url) => String(url).startsWith('https://push.example') ? (pushes++, new Response(null, { status: 201 })) : quote(150);
  for (let i = 0; i < 3; i++) await cron(env);
  ok('1a no repeat pushes while the seen-state cannot persist (was 3)', pushes === 0, pushes);
  const r = await worker.fetch(new Request('https://w/backup', { method: 'POST', body: JSON.stringify({ key: 'a'.repeat(64), blob: { ct: 'x', iv: 'y', salt: 'z' } }) }), env);
  ok('1b /backup answers 503 when nothing was stored (was 200 ok)', r.status === 503 && !env.store.has('backup:' + 'a'.repeat(64)), r.status);
  env.failPut = false;
  const r2 = await worker.fetch(new Request('https://w/backup', { method: 'POST', body: JSON.stringify({ key: 'a'.repeat(64), blob: { ct: 'x', iv: 'y', salt: 'z' } }) }), env);
  ok('1c /backup still 200 when the write lands', r2.status === 200 && env.store.has('backup:' + 'a'.repeat(64)), r2.status);
  await cron(env);
  ok('1d once KV recovers the crossing pushes exactly once', pushes === 1, pushes);
}

// 2. /sync during the cron's quote fetch
{
  const env = mkEnv({ subscription, alerts: [A('a1', 100)], seen: {}, updatedAt: Date.now(), lastActiveAt: 0 });
  let synced = false;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://push.example')) return new Response(null, { status: 201 });
    if (!synced) { synced = true;
      await worker.fetch(new Request('https://w/sync', { method: 'POST', body: JSON.stringify({ clientId: 'dev1', alerts: [A('a1', 100), A('a2', 500)] }) }), env); }
    return quote(150);
  };
  await cron(env);
  const after = JSON.parse(env.store.get('client:dev1'));
  ok('2 alert added mid-cron survives the cron write (was dropped)', after.alerts.map(a => a.id).join(',') === 'a1,a2' && after.seen.a1?.status === 'hit', after.alerts.map(a => a.id));
}

// 3. notification currency symbol (push payload is encrypted, so read the
// plaintext via the evaluate path: assert the source instead).
{
  const src = (await import('node:fs')).readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  ok('3 push title uses MARKET_CURRENCY, not R-or-$', /MARKET_CURRENCY\[t\.market\]/.test(src) && !/'R' : '\$'/.test(src));
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nALL PASSED');
