// Cross-verifies backend/webpush.js against the canonical `http_ece` library
// (the same RFC 8188/8291 implementation web-push uses) plus a VAPID JWT check.
//
//   cd backend/test && npm install && node verify.mjs
//
import crypto from 'node:crypto';
import ece from 'http_ece';
import {
  encryptPayload, vapidAuthHeader, b64urlToBytes, bytesToB64url
} from '../webpush.js';

let failures = 0;
function ok(name, cond) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`);
  if (!cond) failures++;
}

// ── 1. Payload encryption: my encrypt → canonical http_ece decrypt ───────────
async function testEncryptionRoundTrip() {
  for (const payload of ['{"title":"AAPL above $200","body":"Now $201.34"}', 'x', 'a'.repeat(3000)]) {
    // Receiver (browser) keypair + auth secret, generated the way a real UA would.
    const recv = crypto.createECDH('prime256v1');
    recv.generateKeys();
    const p256dh = bytesToB64url(recv.getPublicKey());     // 65-byte uncompressed point
    const auth = bytesToB64url(crypto.randomBytes(16));

    const body = await encryptPayload(new TextEncoder().encode(payload), p256dh, auth);

    const decrypted = ece.decrypt(Buffer.from(body), {
      version: 'aes128gcm',
      privateKey: recv,
      authSecret: auth
    });
    ok(`round-trip (${payload.length}B): http_ece decrypts to original`, decrypted.toString('utf8') === payload);
  }
}

// ── 2. VAPID JWT: sign with my code → verify signature + claims ──────────────
async function testVapid() {
  // Generate a VAPID keypair in the storage format the keygen script emits.
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const VAPID_PUBLIC = bytesToB64url(pubRaw);
  const VAPID_PRIVATE = jwk.d; // already base64url

  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
  const header = await vapidAuthHeader(endpoint, VAPID_PUBLIC, VAPID_PRIVATE, 'mailto:me@example.com');

  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  ok('vapid header shape `vapid t=<jwt>, k=<key>`', !!m);
  if (!m) return;
  const [, jwt, k] = m;
  ok('vapid k= matches public key', k === VAPID_PUBLIC);

  const [h, p, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  ok('jwt aud is endpoint origin', claims.aud === 'https://fcm.googleapis.com');
  ok('jwt exp within 24h future', claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600);

  // Verify the ES256 signature with the public key.
  const verifyKey = await crypto.subtle.importKey('raw', pubRaw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    b64urlToBytes(sig),
    new TextEncoder().encode(`${h}.${p}`)
  );
  ok('jwt ES256 signature verifies', valid);
}

const run = async () => {
  console.log('webpush.js verification\n');
  await testEncryptionRoundTrip();
  await testVapid();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
};
run().catch(e => { console.error(e); process.exit(1); });
