// ─── Dependency-free Web Push ────────────────────────────────────────────────
// Implements RFC 8291 (message encryption, aes128gcm content coding per RFC 8188)
// and RFC 8292 (VAPID) using only WebCrypto, so it runs unchanged on Cloudflare
// Workers and Node 18+. No npm dependencies — nothing to drift or fail to bundle.
//
// Verified against the canonical `http_ece` implementation in backend/test.
// ─────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

// ─── base64url ───────────────────────────────────────────────────────────────
export function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += '='.repeat(pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ─── HKDF (SHA-256), single-block expand — all our outputs are ≤32 bytes ─────
async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);                                   // Extract
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));      // Expand T(1)
  return okm.slice(0, length);
}

// ─── ECDH P-256 ──────────────────────────────────────────────────────────────
async function ecdhShared(privateKey, peerPubRaw) {
  const peer = await crypto.subtle.importKey('raw', peerPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  return new Uint8Array(bits);
}

// ─── Payload encryption (RFC 8291 + RFC 8188 aes128gcm) ──────────────────────
// `serverKeys` lets the test inject a fixed keypair to match RFC test vectors;
// production passes nothing and a fresh ephemeral pair is generated per message.
export async function encryptPayload(payloadBytes, p256dhB64, authB64, opts = {}) {
  const clientPub = b64urlToBytes(p256dhB64);   // 65-byte uncompressed point
  const authSecret = b64urlToBytes(authB64);    // 16-byte auth secret

  let serverPriv, serverPub;
  if (opts.serverKeys) {
    serverPriv = opts.serverKeys.privateKey;
    serverPub = opts.serverKeys.publicRaw;
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    serverPriv = kp.privateKey;
    serverPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }

  const sharedSecret = await ecdhShared(serverPriv, clientPub);

  // RFC 8291 §3.4 — combine auth secret + ECDH secret into the input keying material.
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), clientPub, serverPub);
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  // RFC 8188 §2.2/2.3 — derive content-encryption key + nonce from a random salt.
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  // Single record: plaintext padded with the 0x02 last-record delimiter.
  const padded = concat(payloadBytes, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded));

  // RFC 8188 header: salt(16) || rs(4 BE) || idlen(1) || keyid(server pubkey, 65)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + serverPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = serverPub.length;
  header.set(serverPub, 21);

  return concat(header, ct);
}

// ─── VAPID (RFC 8292) ────────────────────────────────────────────────────────
// Import a raw P-256 keypair (public = 65-byte point, private = 32-byte scalar)
// as a JWK signing key for ES256.
async function importVapidSigningKey(publicB64, privateB64) {
  const pub = b64urlToBytes(publicB64);
  const d = privateB64;
  const x = bytesToB64url(pub.slice(1, 33));
  const y = bytesToB64url(pub.slice(33, 65));
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d, x, y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

export async function vapidAuthHeader(endpoint, publicB64, privateB64, subject) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject || 'mailto:alerts@playbook.app'
  })));
  const signingInput = `${header}.${payload}`;
  const key = await importVapidSigningKey(publicB64, privateB64);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)));
  // WebCrypto ECDSA already returns IEEE-P1363 r||s — exactly JWS ES256 format.
  const jwt = `${signingInput}.${bytesToB64url(sig)}`;
  return `vapid t=${jwt}, k=${publicB64}`;
}

// ─── Send one push message ───────────────────────────────────────────────────
// Returns the push-service HTTP status. 201 = delivered to the service;
// 404/410 = subscription gone (caller should delete it); 429 = backoff.
export async function sendPush(subscription, payloadObj, vapid, fetchImpl = fetch) {
  const bodyBytes = await encryptPayload(
    enc.encode(JSON.stringify(payloadObj)),
    subscription.keys.p256dh,
    subscription.keys.auth
  );
  const authorization = await vapidAuthHeader(subscription.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject);
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '2419200',
      Urgency: 'high'
    },
    body: bodyBytes
  });
  return res.status;
}
