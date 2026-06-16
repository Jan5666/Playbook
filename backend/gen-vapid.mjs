// Generate a VAPID key pair for the push backend.
//
//   node backend/gen-vapid.mjs
//
// Prints VAPID_PUBLIC / VAPID_PRIVATE in the format webpush.js expects. Feed
// them to the Worker as secrets (see backend/README.md). VAPID_PUBLIC is also
// the `applicationServerKey` the PWA subscribes with — the app fetches it from
// the Worker automatically, so you never paste it into the app by hand.
import crypto from 'node:crypto';

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)); // 65-byte point
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);                   // jwk.d is base64url
const b64url = b => Buffer.from(b).toString('base64url');

console.log('\nVAPID key pair — keep the private key secret.\n');
console.log('VAPID_PUBLIC  =', b64url(pubRaw));
console.log('VAPID_PRIVATE =', jwk.d);
console.log('\nSet them on the Worker:');
console.log('  wrangler secret put VAPID_PUBLIC');
console.log('  wrangler secret put VAPID_PRIVATE');
console.log('  wrangler secret put VAPID_SUBJECT     # e.g. mailto:you@example.com\n');
