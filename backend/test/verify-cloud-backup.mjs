// Verifies the cloud-backup feature end to end:
//   1. The real Worker /backup GET+POST routes (imported from ../worker.js) using
//      an in-memory KV stub — proves storage, retrieval, and input validation.
//   2. The client crypto + snapshot logic (mirrored from app.js) under Node's
//      WebCrypto — proves encrypt→decrypt round-trips, that a wrong recovery code
//      fails closed, and that gather/apply restores every durable pb.* key while
//      skipping volatile caches.
//
// Run: node backend/test/verify-cloud-backup.mjs
import worker from '../worker.js';

let failures = 0;
const ok = (cond, msg) => { if (cond) { console.log('  ✓ ' + msg); } else { console.log('  ✗ ' + msg); failures++; } };

// ── In-memory KV stub matching the subset the Worker uses ────────────────────
function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, type) { const v = m.get(k); return v == null ? null : (type === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix, cursor } = {}) {
      const keys = [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name }));
      return { keys, list_complete: true };
    }
  };
}
const req = (method, path, body) => new Request('https://x' + path, {
  method, headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined
});

async function testWorkerRoutes() {
  console.log('Worker /backup routes:');
  const env = { PB: makeKV() };
  const key = 'a'.repeat(64); // a valid SHA-256-shaped lookup key
  const blob = { v: 1, salt: 'c2FsdA==', iv: 'aXZpdml2aXY=', ct: 'Y2lwaGVydGV4dA==' };

  // POST stores it
  let res = await worker.fetch(req('POST', '/backup', { key, blob }), env);
  let json = await res.json();
  ok(res.status === 200 && json.ok === true && typeof json.updatedAt === 'number', 'POST stores blob → ok + updatedAt');
  ok(env.PB._m.has('backup:' + key), 'stored under backup: prefix (cron lists client: only, so it is ignored)');

  // GET round-trips the exact blob
  res = await worker.fetch(req('GET', '/backup?key=' + key), env);
  json = await res.json();
  ok(res.status === 200 && JSON.stringify(json.blob) === JSON.stringify(blob), 'GET returns the stored blob verbatim');

  // Validation
  ok((await worker.fetch(req('GET', '/backup?key=NOPE'), env)).status === 400, 'GET bad key → 400');
  ok((await worker.fetch(req('GET', '/backup?key=' + 'b'.repeat(64)), env)).status === 404, 'GET unknown key → 404');
  ok((await worker.fetch(req('POST', '/backup', { key, blob: { ct: 1 } }), env)).status === 400, 'POST malformed blob → 400');
  ok((await worker.fetch(req('POST', '/backup', { key: 'short', blob }), env)).status === 400, 'POST bad key → 400');

  // Existing push route still requires a clientId (backup branch did not break it)
  ok((await worker.fetch(req('POST', '/subscribe', {}), env)).status === 400, '/subscribe still rejects missing clientId');
}

// ── Client logic mirrored from app.js (kept identical on purpose) ────────────
const BACKUP_PREFIX = 'pb.';
const BACKUP_SKIP = new Set(['pb.prices.v1', 'pb.nameCache.v1', 'pb.fxRates.v1', 'pb.sectorCache.v1', 'pb.heatmap.lastgood.v1', 'pb.installDismissed.v2', 'pb.backup.lastSync.v1']);
const store = new Map(); // fake localStorage
const localStorage = {
  get length() { return store.size; },
  key(i) { return [...store.keys()][i]; },
  getItem(k) { return store.has(k) ? store.get(k) : null; },
  setItem(k, v) { store.set(k, String(v)); },
  removeItem(k) { store.delete(k); }
};
function gatherBackup() {
  const keys = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(BACKUP_PREFIX) || BACKUP_SKIP.has(k)) continue;
    const v = localStorage.getItem(k);
    if (v != null) keys[k] = v;
  }
  return { v: 1, app: 'playbook', exportedAt: new Date().toISOString(), keys };
}
function applyBackup(payload) {
  if (!payload || typeof payload !== 'object' || !payload.keys) return -1;
  let n = 0;
  for (const k in payload.keys) { if (!k.startsWith(BACKUP_PREFIX)) continue; localStorage.setItem(k, payload.keys[k]); n++; }
  return n;
}
const _b64 = b => Buffer.from(b).toString('base64');
const _unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const normalizeCode = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function deriveAesKey(code, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptBlob(code, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(code, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { v: 1, salt: _b64(salt), iv: _b64(iv), ct: _b64(ct) };
}
async function decryptBlob(code, blob) {
  const key = await deriveAesKey(code, _unb64(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _unb64(blob.iv) }, key, _unb64(blob.ct));
  return new TextDecoder().decode(pt);
}

async function testClientCrypto() {
  console.log('Client snapshot + crypto:');
  store.clear();
  localStorage.setItem('pb.positions.v2', JSON.stringify([{ ticker: 'AAPL', shares: 3 }]));
  localStorage.setItem('pb.sectorWeights.v1', JSON.stringify({ VTI: { Tech: 0.3 } }));
  localStorage.setItem('pb.theme.v2', '"dark"');
  localStorage.setItem('pb.prices.v1', JSON.stringify({ huge: 'cache' })); // must be skipped

  const snap = gatherBackup();
  ok('pb.positions.v2' in snap.keys && 'pb.sectorWeights.v1' in snap.keys && 'pb.theme.v2' in snap.keys, 'gather captures durable keys');
  ok(!('pb.prices.v1' in snap.keys), 'gather skips volatile cache (pb.prices.v1)');

  const code = 'ABCD-EFGH-JKMN';
  const blob = await encryptBlob(normalizeCode(code), JSON.stringify(snap));
  ok(typeof blob.ct === 'string' && !blob.ct.includes('AAPL'), 'ciphertext does not leak plaintext');

  const back = JSON.parse(await decryptBlob(normalizeCode(code), blob));
  ok(JSON.stringify(back) === JSON.stringify(snap), 'decrypt with correct code round-trips the snapshot');

  let threw = false;
  try { await decryptBlob(normalizeCode('ZZZZ-ZZZZ-ZZZZ'), blob); } catch (_e) { threw = true; }
  ok(threw, 'decrypt with wrong code fails closed (no plaintext leak)');

  // Simulate a wiped device: clear storage, then restore from the decrypted snapshot
  store.clear();
  const n = applyBackup(back);
  ok(n === 3 && localStorage.getItem('pb.positions.v2') === JSON.stringify([{ ticker: 'AAPL', shares: 3 }]), 'applyBackup restores every key onto a wiped store');
  ok(localStorage.getItem('pb.prices.v1') === null, 'volatile cache not resurrected by restore');
}

await testWorkerRoutes();
await testClientCrypto();
console.log(failures === 0 ? '\nAll cloud-backup checks passed ✓' : `\n${failures} check(s) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
