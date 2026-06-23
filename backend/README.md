# Playbook push backend

A tiny Cloudflare Worker that delivers price-alert notifications to your phone
**even when the app is fully closed** — the one thing a static PWA can't do by
itself (especially on iOS). It checks your alerts once a minute during market
hours and pushes the moment a target is crossed. Your phone does nothing but
receive the push, so battery cost is negligible.

Everything runs on Cloudflare's **free** tier (Workers + Cron Triggers + KV).

```
backend/
  worker.js      Worker: HTTP API (subscribe/sync) + cron price-check + push
  webpush.js     Dependency-free Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID)
  wrangler.toml  Deploy config (KV binding + 1-minute cron)
  gen-vapid.mjs  One-shot VAPID key generator
  test/          Node tests (crypto verified against canonical http_ece)
```

## Deploy (≈5 minutes)

You need [Node](https://nodejs.org) and a free [Cloudflare](https://dash.cloudflare.com) account.

```bash
npm install -g wrangler        # Cloudflare CLI
cd backend
wrangler login                 # opens a browser to authorise
```

**1. Create the KV namespace** and paste the printed `id` into `wrangler.toml`
(replacing `PASTE_KV_NAMESPACE_ID_HERE`):

```bash
wrangler kv namespace create PB
```

**2. Generate VAPID keys** and set them as secrets:

```bash
node gen-vapid.mjs
wrangler secret put VAPID_PUBLIC      # paste the VAPID_PUBLIC value
wrangler secret put VAPID_PRIVATE     # paste the VAPID_PRIVATE value
wrangler secret put VAPID_SUBJECT     # e.g. mailto:you@example.com
```

**3. Deploy:**

```bash
wrangler deploy
```

You'll get a URL like `https://playbook-push.<your-subdomain>.workers.dev`.

**4. Connect the app:** open Playbook → **Alerts** (bell icon) → paste that URL
into **Background push server** → **Connect**. That's it — the app fetches the
VAPID key, subscribes this device, and keeps your alert list synced. On iPhone,
install to the Home Screen first (iOS 16.4+) and open from the icon.

Tap **Send test push** to confirm delivery.

## How it works

- **`POST /subscribe`** — the app registers `{ clientId, subscription, alerts }`;
  stored as one KV record per device (`client:<id>`).
- **`POST /sync`** — the app re-sends its alert list whenever it changes, and
  sends a heartbeat when foregrounded (so the server suppresses duplicate pushes
  while you're actively looking at the app).
- **`scheduled` (cron, every minute)** — for each device, fetch quotes for active
  alerts whose market is currently open, evaluate triggers, and push anything
  newly hit. KV is written **only when trigger state changes**, so a normal
  trading day stays far inside the free-tier write quota; off-hours runs fetch
  nothing.
- **`GET /vapid-public-key`**, **`POST /unsubscribe`**, **`POST /test`** round it out.
- **`POST /backup`** / **`GET /backup?key=…`** — encrypted data backup. The app
  stores a zero-knowledge snapshot of all its data keyed by `SHA-256(recoveryCode)`
  under `backup:<hash>`. The server only ever sees the hash and **opaque AES-GCM
  ciphertext** — the recovery code never leaves the device, so a KV dump can't
  reveal anyone's portfolio. This is what lets data survive deleting + re-adding
  the iOS home-screen icon (which wipes on-device storage). Connect it in the app
  under **Settings → Data → Cloud backup** (reuses the push server URL).

Trigger semantics (cross-once, 5-minute cooldown before re-arming) mirror the
in-app and service-worker engines exactly, so the three layers never double-fire.

## Cost / limits

| Resource | Free tier | This worker |
|----------|-----------|-------------|
| Worker requests | 100k/day | ~1,440 cron + a handful of API calls |
| KV reads | 100k/day | ~1,440 × (devices) |
| KV writes | 1k/day | only on trigger-state change (≪ quota) |

Holidays aren't special-cased: on a market holiday quotes are flat, so no trigger
transitions occur and nothing fires.

## Tests

```bash
cd backend/test
npm install
node verify.mjs        # encryption cross-checked against canonical http_ece + VAPID JWT
node worker.test.mjs   # trigger evaluation + market-hours logic
node verify-cloud-backup.mjs   # /backup routes + client encrypt/restore round-trip
```
