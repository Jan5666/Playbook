# Playbook — Security & Platform Roadmap

**Status:** Proposed (awaiting Jan's review) · **Date:** 2026-07-06 · **Audited at:** branch `refactor/phase-4-increment-6-markets-currencies-content` (head `a39c791`, origin/main `20e94b8`)

This document is the step-by-step plan to (1) harden how Playbook collects third-party
financial data, (2) add secure multi-device cloud storage, (3) ship iOS PWA push
notifications properly, and (4) prepare for future broker integrations (EasyEquities).

> **Relationship to the existing refactor plan — READ FIRST**
>
> This roadmap **does not alter, replace, or reorder** the ongoing refactor
> (Phases 0–5, tracked in `docs/superpowers/` and memory). The refactor finishes
> first. Every phase below is designed to *slot in after* (or alongside) the
> remaining refactor work without touching its scope:
>
> | Refactor item (still open) | How this roadmap relates |
> |---|---|
> | Phase 4: first view/modal component split (+ deferred Vite decision) | Independent. Nothing here requires a build step; nothing here forbids one. |
> | Phase 5: IndexedDB behind a cache interface | **Prerequisite-aligned**: Roadmap Phase 3's iOS storage work *is* refactor Phase 5 — do it once, there. |
> | Phase 5 (optional): "shared quote-cache in Worker → retire public proxies" | **Formalized here** as Roadmap Phase 1. Same idea, now with a concrete design. |
>
> Sequencing rule: start Roadmap Phase 1 only after the refactor phases Jan wants
> done are merged. Where a roadmap task and a refactor task overlap (noted inline),
> the refactor task is the canonical home for the work.

---

## 0 · Current state: architecture & third-party data audit

### 0.1 Architecture snapshot (verified 2026-07-06)

- **Frontend:** no-build static PWA on GitHub Pages. `index.html` loads React 18.3.1
  UMD from unpkg, Google Fonts, then six first-party global scripts
  (`pb-core.js` pure logic → `pb-data.js` network → `pb-store.js` state →
  `pb-content.js` content → `pb-import.js` import/OCR → `data.js` → `app.js`, ~12.3k lines).
- **Persistence:** localStorage (`pb.*` keys, via PBStore settings/collections);
  IndexedDB used only by the service worker for background-alert state.
- **Service worker (`sw.js`):** precaches the shell (network-first), handles Web Push
  display, and runs its own background alert check (Periodic Background Sync,
  Chromium-only) with a **duplicated** proxy chain + duplicated
  `yahooSymbol`/`centDivisor`/trigger evaluator.
- **Backend (`backend/worker.js`):** one Cloudflare Worker + KV.
  - `scheduled()` cron (per minute): fetches quotes for active alerts, evaluates via
    shared `pb-core.js`, sends VAPID Web Push. This is the app-closed alert path (and
    the only one that works on iOS).
  - `/backup`: **zero-knowledge** encrypted backup store — client encrypts with
    AES-256-GCM (key = PBKDF2-SHA-256, 150k iterations, from a 60-bit recovery code);
    server stores ciphertext under `SHA-256(code)`. The server cannot read portfolios.
  - Secrets (VAPID keys) live in Wrangler secrets, not in code. ✅
- **Deploy:** GitHub Pages workflow stages an **allowlist** of runtime assets into
  `_site/` with missing-asset and secret-leak guards (post-incident hardening). ✅

### 0.2 Third-party data flows (the audit)

| # | Provider | Data | Transport today | Trust concern |
|---|---|---|---|---|
| 1 | Yahoo Finance v8 chart (unofficial) | Quotes, history, extended hours | Browser → **1 of 6 free public CORS proxies** → Yahoo | **High** — see F1/F2 |
| 2 | Stooq | Quote fallback (CSV) | Same proxy ladder | Same as above |
| 3 | FRED | Macro series (CPI, Fed funds…) | Proxy ladder | Low sensitivity, same integrity risk |
| 4 | stockanalysis.com | Fundamentals, sector, earnings dates (US) | **Direct** (CORS-open) | Medium — availability only |
| 5 | Morningstar | Unit-trust search/prices | Proxy ladder | Same as #1 |
| 6 | Perplexity API | AI news/fundamentals | **Direct**, user's own API key (localStorage, user-supplied) | Acceptable by design; key is XSS-reachable (F5) |
| 7 | rss2json.com | News RSS conversion | Direct | Low |
| 8 | open.er-api.com (FX) | FX rates, historical FX | Direct-first, proxy fallback (`FX_PROXIES`, app.js) | Medium — FX feeds money math |
| 9 | unpkg.com | React runtime | Direct `<script>` — **no SRI** | **High** — supply chain (F3) |
| 10 | Google Fonts | Fonts | Direct | Low (privacy: IP + UA to Google) |

### 0.3 Findings

Severity: 🔴 fix in Phase 1 · 🟠 fix in its phase · 🟡 tracked/accepted.

- **F1 🔴 Untrusted intermediaries can read the user's watch universe.** Every
  polled symbol (positions, watchlist, alerts) flows through whichever of the 6
  free CORS proxies answers first. Operators of those proxies see a fingerprint of
  the user's portfolio + IP on every 45s poll. (Already flagged as A5/privacy in the
  architecture audit; this roadmap is the fix.)
- **F2 🔴 Untrusted intermediaries can *write* the user's prices.** A malicious or
  compromised proxy can return altered but well-formed JSON. Prices drive P/L
  display *and alert triggers* (client, sw.js, and Worker cron all fetch through
  proxy ladders). There is no cross-source corroboration before a money-relevant
  alert fires. Integrity, not just privacy.
- **F3 🔴 Supply-chain exposure: React from unpkg with no Subresource Integrity.**
  A compromised CDN response executes arbitrary JS in the app's origin — which
  holds the portfolio, the Perplexity key, and the push subscription. Fonts CSS is
  the same class of issue (lower impact).
- **F4 🔴 The Worker API is world-writable.** `Access-Control-Allow-Origin: *`, no
  authentication, no rate limits on `/subscribe`, `/sync`, `/backup` POST/GET.
  Consequences: KV quota-exhaustion DoS (anyone can store ~4.5MB blobs under
  arbitrary keys), backup-key brute-force is throttled only by network speed
  (keyspace is 2^60 — large, but unthrottled guessing is still a design smell),
  junk `client:` records inflate the cron loop.
- **F5 🟠 No Content-Security-Policy anywhere.** GitHub Pages cannot set response
  headers. Any XSS (e.g. via a malicious import file or a poisoned news title)
  currently has free rein: exfiltrate localStorage (portfolio, Perplexity key),
  call the push backend. CSP is the single highest-leverage XSS mitigation
  available to this app.
- **F6 ✅ sw.js re-implements pb-core logic — FIXED 2026-07-21** (branch
  `claude/refactor-plan-continuation-645imf`). sw.js now `importScripts('./pb-core.js')` and
  delegates to `PBCore.yahooSymbol` / `PBCore.centDivisor` / `PBCore.evaluateAlerts`; the drifted
  `swYahooSymbol` / `swCentDivisor` / `swEvaluate` copies were deleted, closing the ^SPX / JSE-ZAR
  drift in the background alert path. The proxy ladder (`SW_PROXIES`) stays inline — pb-data.js is
  browser-only (rule #6); its consolidation remains under F-series/Phase-1 (gap #4). Guard:
  `backend/test/sw-core-delegation.test.mjs`.
- **F7 🟡 localStorage is unencrypted at rest on device.** Acceptable for a
  personal device app (OS-level protection applies), but worth revisiting when
  cloud sync makes the data multi-device (Phase 2 keeps E2EE for the cloud copy).
- **F8 🟡 Deployed Worker lags the repo** (postponed task): the live cron still runs
  pre-pb-core logic until `wrangler deploy` is run. Known, low urgency, listed in
  Phase 1 as a closing task.
- **F9 🟡 `demo-data.js` deploy-allowlist gap** (postponed task #4): precached by
  sw.js and loaded by index.html but not staged by `static.yml` → 404 on the live
  site can reject the entire `cache.addAll()` precache. Reliability bug with a
  security-adjacent fix location (the allowlist). Fix in Phase 1.
- **F10 🟡 Backup KDF parameters are era-appropriate but not generous.**
  PBKDF2-SHA-256 @ 150k iterations, 60-bit recovery code. Fine against online
  attack once F4 rate-limiting lands; an offline attacker who dumps KV still faces
  ~2^60 × 150k hashes. Cheap upgrades exist (blob is versioned `v:1`, so a `v:2`
  with higher cost / longer code is a clean migration). Phase 2.

### 0.4 What is already strong (preserve, don't regress)

- Zero-knowledge cloud backup (server provably can't read portfolios).
- Secrets discipline: VAPID in Wrangler secrets; `.gitignore` + deploy guards;
  Stooq cookie purged from history; Perplexity key is user-supplied, never shipped.
- Allowlist-based Pages deploy with leak guards (post-incident, battle-tested).
- Shared client/server alert + symbol logic in `pb-core.js` with an equivalence-proof
  test suite (19 node suites), in-flight de-dupe + global fetch cap in `pb-data.js`.
- The Worker stores only what it needs (alerts + subscription), sanitized
  (`sanitizeAlerts`), with TTL garbage collection.

---

## Phase 1 · Audit & Hardening — own the data plane

**Goal:** all market data flows through *one first-party, cached, rate-limited edge
endpoint*; the app's origin is hardened against supply-chain and XSS classes.
**Closes:** F1, F2, F3, F4, F5 (interim), F6, F8, F9.

### 1.1 First-party quote proxy: `playbook-quotes` (or new routes on the existing Worker)

Replace the 6 public CORS proxies with a Cloudflare Worker the app owns.

Design:

- **Routes:** `GET /quote?symbols=US:AAPL,JSE:SOL,...` (batched — one round-trip per
  sweep instead of per-symbol), `GET /history?symbol=…&range=…`, `GET /fx?base=USD`,
  `GET /macro?series=CPIAUCSL`. The Worker maps each to the upstream
  (Yahoo/Stooq/FRED/open-er-api) using the *same* `pb-core.js` symbol logic it
  already bundles.
- **Edge caching:** Cloudflare Cache API / `caches.default` keyed by
  symbol+interval, TTL ~30–60s for quotes while market open, hours when closed
  (reuse `PBCore.marketOpen`), ~1h for FX, ~1d for macro. Every installed device
  then shares one upstream fetch — this alone cuts upstream volume by the device
  count and makes rate-limit bans an order of magnitude less likely.
- **Fault tolerance:** upstream ladder *inside* the Worker (query1 → query2 →
  Stooq), per-upstream circuit breaker (skip a host for N minutes after
  consecutive failures), and **stale-while-revalidate**: serve the last cached
  value with a `stale: true, asOf` marker rather than nothing. The client's
  existing `failStreak`/refresh-chip UX already knows how to present staleness.
- **Rate limiting:** Cloudflare rate-limiting rules (or an in-Worker token bucket
  in KV/Durable Object) per IP: generous for real use (~1 batched call/10s),
  hostile to scraping. Return `429` + `Retry-After`; the client backs off.
- **Transit/CORS:** `Access-Control-Allow-Origin` pinned to the Pages origin (plus
  `http://localhost:*` in dev). HTTPS end-to-end (already). No cookies, no user
  identifiers in quote requests — symbols stop leaking to third parties (F1), and
  responses come from a party we control (F2).
- **Integrity guard for money-relevant events (F2):** before the *alert cron*
  fires a push, corroborate the trigger price against a second source (Yahoo vs
  Stooq within a tolerance band) or against last-known price (reject absurd
  single-tick jumps unless corroborated). Display-path quotes stay single-source
  (latency matters more; UI staleness markers cover it).
- **Client change:** `pb-data.js`'s `fetchViaProxies` gains a first entry
  "playbook edge" and keeps the public-proxy ladder as a *degraded fallback* for
  one release; remove the public list once the edge proves reliable. sw.js and
  worker.js switch the same way. (Small diff: the ladder is already one function
  in each place.)
- **Cost check:** Workers free tier = 100k req/day. One user polling a 20-symbol
  batched endpoint every 45s ≈ 1.9k req/day. Dozens of devices fit free; paid tier
  ($5/mo) removes thought entirely.

**Acceptance:** a full app session (cold start, poll sweeps, detail views, alert
cron) makes **zero** requests to corsmirror/cors.lol/allorigins/corsproxy.io/codetabs;
Yahoo sees only the Worker's IPs; pulling the edge's network cable (kill the Worker)
degrades to marked-stale data, not blank UI.

### 1.2 Origin hardening (F3, F5-interim)

1. **Self-host React** (two UMD files, ~150KB total, already precached pattern):
   copy into the repo, add to `static.yml` allowlist + `SHELL_ASSETS`, drop unpkg.
   Kills the CDN supply chain *and* removes a cold-start SPOF. (If Jan prefers
   keeping unpkg: add `integrity="sha384-…"` + `crossorigin` instead — lesser fix.)
2. **Self-host the two font families** (woff2 subset) for the same reasons; or
   accept Google Fonts and pin it in CSP.
3. **Interim CSP via `<meta http-equiv="Content-Security-Policy">`** in
   `index.html`: `default-src 'self'; connect-src 'self' https://<worker-domain>
   https://api.perplexity.ai …; script-src 'self'; object-src 'none';
   base-uri 'none'`. (Meta-CSP can't do `frame-ancestors`/reporting — full headers
   arrive with 1.4.) Audit inline `<script>` blocks in index.html → move to a file
   or hash them.
4. **Escape-audit** the two places third-party *text* enters the DOM (news titles,
   import parsing) — React escapes by default; verify no `dangerouslySetInnerHTML`
   / raw HTML paths exist (quick grep + test).

### 1.3 Worker API hardening (F4)

- Pin CORS to the Pages origin (both existing and new routes).
- Cloudflare rate-limit rules: `/backup` GET (brute-force throttle: e.g.
  10/min/IP), `/backup` POST (quota protection), `/subscribe|/sync` (write
  throttle).
- `/backup` POST: require the key to prove knowledge of the code, not just the
  hash shape — trivially: store/verify against `SHA-256("v2:" + code)` while
  continuing to accept v1 reads (prevents blind-key junk uploads only when paired
  with rate limits; keyspace already does most of the work).
- Optional (cheap, high value): move the Worker behind a custom domain proxied by
  Cloudflare → full WAF, bot management, analytics.

### 1.4 Serving-platform decision (enables real headers)

GitHub Pages cannot send `Content-Security-Policy`, `Strict-Transport-Security`,
`X-Content-Type-Options`, `Permissions-Policy`. Two options:

- **A (recommended): Cloudflare Pages** — same allowlist staging step, `_headers`
  file for CSP/HSTS, same-platform as the Workers (service bindings later), free.
- **B: keep GitHub Pages** behind a Cloudflare-proxied custom domain (Transform
  Rules add headers).

Either way the deploy allowlist + guards migrate unchanged. Decision is Jan's;
nothing else in the roadmap depends on which.

### 1.5 Consolidation & closing known gaps

- **sw.js drift (F6): ✅ DONE 2026-07-21.** sw.js `importScripts('./pb-core.js')` and delegates
  `swYahooSymbol`/`swCentDivisor`/`swEvaluate` to PBCore, with the anti-drift guard
  (`backend/test/sw-core-delegation.test.mjs`) in the worker.js pattern. When 1.1 lands, the inline
  `SW_PROXIES` list becomes the edge URL.
- **F9:** add `demo-data.js` to `static.yml` (or drop it from precache — Jan's call).
- **F8:** `cd backend && npx wrangler deploy --dry-run` then `deploy` (Jan runs;
  needs his Cloudflare login).
- **Secrets hygiene re-check:** `git log --diff-filter=A` scan + `gitleaks` run as
  a one-off; consider a pre-commit gitleaks hook (matches the standing
  security-safeguards memory).

**Phase 1 exit criteria:** third-party proxies gone; SRI/self-hosted runtime; CSP
active (meta at minimum); Worker CORS pinned + rate-limited; sw.js drift closed;
live Worker current; deploy allowlist complete.

---

## Phase 2 · Cloud Integration — accounts, sync, RLS

**Goal:** portfolio data lives in secure per-user cloud storage with strict
isolation, multi-device sync, and the existing zero-knowledge property preserved.
**Closes:** F10; extends the `/backup` design into real sync.

### 2.1 Principle: E2EE first, RLS as defense-in-depth

Playbook's best security property today is that the server *cannot* read
portfolios. Keep it. Cloud sync therefore stores **ciphertext rows**, and
row-level access control protects *availability and metadata*, not plaintext.
This also makes the provider choice low-stakes: even a full database breach leaks
only encrypted blobs + timestamps.

### 2.2 Two architectures (pick one in a short spike)

**Option A — Stay on Cloudflare (recommended for current scale).**
KV blob → **D1** (SQLite) or Durable Objects via the existing Worker.

- Schema: `users(id, auth_credential, created_at)`,
  `snapshots(user_id, key_slot, ciphertext, iv, salt, version, updated_at)`,
  optionally per-slice rows (`slice` = positions/watchlist/…) for delta sync.
- D1 has **no RLS** — isolation is enforced in Worker code: every query is
  written `WHERE user_id = ?` with the id taken *only* from the verified session,
  never from the request body; enforced by a tiny data-access layer + tests that
  prove cross-user reads fail. Single-tenant Worker code is the security boundary
  (same trust level as today's KV design).
- Pros: no new vendor, free tier, the Worker already exists, zero-knowledge
  unchanged. Cons: hand-rolled auth, no SQL-level guarantee.

**Option B — Supabase (Postgres + RLS) if Playbook grows into a multi-user product.**

- Auth: Supabase Auth (email OTP or **passkeys**); client talks PostgREST with the
  anon key; **RLS is the security boundary**:

  ```sql
  alter table snapshots enable row level security;

  create policy "owner-only"
    on snapshots for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  -- No service-role key ever ships to the client; storage buckets get the
  -- mirror-image policy; every table denies by default.
  ```

- Financial payloads remain client-encrypted (columns `ciphertext/iv/salt`), so
  RLS + E2EE stack. Pros: real RLS, accounts/recovery UX for free, room to grow.
  Cons: second vendor, key management story must not silently degrade to
  server-readable "for convenience".

### 2.3 Key management (both options)

- Keep the recovery-code UX; add a **v2 KDF**: longer code (80+ bits, e.g.
  XXXX-XXXX-XXXX-XXXX) and PBKDF2 iterations ≥ 600k (OWASP current) or Argon2id
  via a small WASM lib. Blob `v` field already supports migration: write v2,
  read v1+v2, re-encrypt on first successful open (F10).
- Optional upgrade path: passkey-wrapped keys (WebAuthn PRF extension) so sync
  unlock = Face ID, with recovery code as fallback. Safari/iOS 18+ supports PRF.

### 2.4 Sync semantics (design once, on paper, before code)

- Offline-first: local store (localStorage now; IndexedDB after refactor Phase 5)
  remains the source of truth; sync is an async mirror.
- Per-slice versioned rows + `updated_at` last-write-wins is sufficient for one
  human on ≤3 devices; document the conflict rule and surface "synced Ns ago" in
  the existing refresh-chip pattern. No CRDTs unless real conflicts get reported.
- Backup/restore paths (`gatherBackup`, `applyBackup`) already serialize exactly
  the right keys — reuse them as the sync payload builders.

**Phase 2 exit criteria:** two devices converge through the cloud with the server
unable to decrypt (demonstrated by a test that reads raw rows); cross-user access
provably denied (RLS test or Worker DAL test); old KV `/backup` blobs readable
until migrated; recovery-code rotation works.

---

## Phase 3 · iOS PWA Push Notifications & Background Work

**Goal:** reliable price-alert pushes on iPhone with the app closed, meeting
Apple's iOS 16.4+ Web Push requirements, inside iOS storage/suspension limits.

Reality check: **~80% of this already exists** (VAPID Worker + cron, sw.js `push`
handler, standalone manifest, `usePushBackend` UI). Phase 3 is an audit + gap-fill,
not a build-from-scratch.

### 3.1 Apple requirements checklist (verify each, fix gaps)

| Requirement | Status | Action |
|---|---|---|
| iOS 16.4+, app **installed via Add to Home Screen** (no install API on iOS) | N/A (user step) | Add an in-app "Enable alerts on iPhone" walkthrough: detect `!standalone && isIOS` → show A2HS instructions; detect standalone → offer the permission button. `isIOS`/standalone helpers already exist in app.js. |
| `display: standalone` in the *active* manifest | ✅ both manifests | Keep — icon-theme swap must never point at a manifest without it (add a test). |
| `Notification.requestPermission()` only from a **user gesture** | Verify | Audit `usePushBackend`/notification-permission ladder: the request must run in the click handler's synchronous task; never on load. |
| VAPID key pair, private key server-side only | ✅ | `gen-vapid.mjs` + Wrangler secrets; document rotation: new keypair → clients re-subscribe on next `/vapid-public-key` mismatch (add that check). |
| **Every push must display a notification** (no silent pushes; Safari revokes subscriptions for violations) | ✅ mostly | sw.js `push` handler always calls `showNotification` — keep it unconditional; never send data-only pushes from the Worker. |
| Handle `pushsubscriptionchange` | ❓ gap | Add sw.js listener: re-subscribe with stored VAPID key and POST `/sync` the new subscription. |
| Payload ≤ ~4KB, encrypted (RFC 8291) | ✅ | `webpush.js` + vendored `http_ece` already implement aes128gcm. |
| Expired subscriptions (404/410) pruned | ✅ | worker.js already deletes gone clients. |
| App badge (nice-to-have, iOS 16.4+) | ❌ | `navigator.setAppBadge(n)` from the app + `e.waitUntil(self.registration.setAppBadge?.())` alongside `showNotification`. |

### 3.2 iOS platform limitations — how the architecture absorbs them

- **No Periodic Background Sync / aggressive process suspension on iOS.** The sw.js
  `periodicsync` path will simply never run there — by design the **Worker cron is
  the iOS alert path** (server does the work; phone only renders the push). Keep the
  existing `ACTIVE_SUPPRESS_MS` foreground-dedupe. Document loudly in code that
  sw-side checking is a Chromium-only bonus.
- **Storage budget ("50MB" class caps).** iOS gives installed PWAs a constrained
  origin quota (historically ~50MB for Cache API; newer iOS scales with disk but
  evicts under pressure — treat the budget as small and eviction as expected):
  - Current shell precache is ~1.3MB (fits with 40× headroom). Add a CI guard:
    fail deploy if `_site` total exceeds e.g. 10MB, so a future asset doesn't
    silently blow the budget.
  - Churny/large data (price history, name/sector caches, transactions) moves to
    IndexedDB **in refactor Phase 5** (canonical home for that work); wrap all
    quota writes in `QuotaExceededError` handling that degrades to in-memory.
  - Add a Settings → diagnostics line using `navigator.storage.estimate()`.
  - Note: since iOS 17, *browser-tab* site data can be evicted after inactivity,
    but **installed home-screen apps are exempt from the 7-day eviction** — one
    more reason the A2HS walkthrough matters.
- **One more iOS quirk to encode:** each Home Screen install is a separate storage
  origin instance — reinstalling loses local data. This makes **Phase 2 cloud sync
  the real durability story for iOS**, with the existing file-export (Share sheet
  path already implemented) as belt-and-braces.

### 3.3 Operational tasks

1. Run the Apple-checklist audit above; fix the two known gaps
   (`pushsubscriptionchange`, badge) + whatever the gesture audit finds.
2. Deploy the current Worker (Phase 1 F8 — prerequisite for correct
   ^SPX/JSE-ZAR alert pushes).
3. End-to-end test matrix on Jan's iPhone: install → permission → `/test` push
   (button exists in Settings) → app-closed cron push → notification tap opens
   app → badge count → unsubscribe.
4. Add a `backend/test/` case pinning "every push produces a visible
   notification payload" (guards the Safari-revocation rule).

**Phase 3 exit criteria:** app-closed price alert arrives on an iPhone with the
PWA installed; permission flow passes the gesture rule; subscription survives
rotation via `pushsubscriptionchange`; storage diagnostics visible; no silent-push
code path exists.

---

## Phase 4 · External Broker Integrations (EasyEquities et al.)

**Goal:** automatic portfolio pulls without ever holding user credentials in a
form the server (or an attacker who owns the server) can silently abuse.

### 4.1 Decision ladder — exhaust the safer rungs first

1. **Today (already shipped): zero-credential import.** The EE screenshot-OCR /
   CSV import pipeline (`pb-import.js`) pulls holdings with *no credentials at
   all*. This remains the default and the fallback forever.
2. **Aggregator, if coverage exists.** A licensed aggregator (SnapTrade-style
   brokerage APIs; Plaid Investments is US/CA-only; SA fintech aggregators —
   Stitch/Mono — are payments-oriented) means credentials/OAuth live with a party
   whose entire business is that custody, and Playbook only ever holds
   **revocable, read-only access tokens**. Action item: a timeboxed survey of
   EE coverage by aggregators + whether EE's platform (or Satrix/Shyft peers)
   exposes any partner API. If yes → integrate tokens, skip 4.3 entirely.
3. **Official/partner API.** Watch EE's developer surface; a read-only OAuth
   scope obsoletes everything below.
4. **Credential vault + automated login (last resort).** Only if 1–3 fail and
   Jan still wants unattended pulls. Design below, with eyes open: storing real
   brokerage credentials is the single riskiest feature this app could ever ship,
   and screen-automation likely violates EE's terms of service and breaks on
   every login-flow change or OTP challenge. Build it *only* for Jan's own
   account first, never as a default-on feature.

### 4.2 The honest cryptographic trade-off (design constraint)

True zero-knowledge (server can never decrypt) and **unattended scheduled pulls**
(server decrypts while you sleep) are mutually exclusive. So the vault offers two
modes, and the UI must never blur them:

- **Mode U — user-present pulls (zero-knowledge preserved, default).**
  Credentials are encrypted client-side (AES-256-GCM; key from the Phase-2 KDF,
  or WebAuthn PRF so unlock = Face ID) and stored as ciphertext (locally and/or
  in the Phase-2 store). On "Refresh from EE": the client decrypts in memory,
  drives the login through a dedicated **connector Worker** that *forwards but
  never persists* the secret (no logs, no KV writes of plaintext, memory-only,
  short-lived session token returned), pulls holdings, wipes. Server-side storage
  never contains decryptable credentials.
- **Mode S — scheduled pulls (server-custodied, envelope encryption, opt-in).**
  - Per-user **DEK** (AES-256-GCM) encrypts the credential record.
  - DEK is wrapped by a **KEK** that never touches the data store: held in a
    cloud KMS (AWS KMS / GCP KMS) or, minimally, a Wrangler secret in a
    *separate, single-purpose connector Worker* — not the quotes/push Worker.
  - Unwrap happens only inside the connector at pull time; plaintext lifetime =
    one request; wrapped DEKs live in D1/KV; KEK rotation re-wraps DEKs without
    touching credentials.
  - **Isolation:** its own Worker + own KV/D1 namespace + own secrets; the
    main app talks to it via one authenticated internal route (service binding);
    per-user audit log (`pulled_at`, result, IP) surfaced in Settings.
  - **Kill switch:** one flag disables all scheduled pulls; users can purge their
    record instantly (`DELETE` = KV/D1 delete + KEK-rotation makes stragglers
    undecryptable).
- **Both modes:** session cookies/tokens obtained from the broker are stored (if
  at all) encrypted with the same envelope, expire aggressively, and are scoped
  read-only where the broker allows. 2FA/OTP accounts can only use Mode U
  (the human supplies the OTP) — say so in the UI rather than failing mysteriously.

### 4.3 Data-pull execution security (either mode)

- Connector egress goes direct from Cloudflare to the broker over TLS — no
  third-party proxies ever touch credentialed traffic (Phase 1's lesson applied).
- Responses are parsed to the *minimum* holdings schema (`ticker, qty, avg cost,
  currency`) — raw HTML/session artifacts are never stored.
- Pulled holdings enter the app through the **existing import pipeline**
  (`rankImportCandidates` etc.), so matching/merge behavior is identical to
  manual imports and covered by the existing test suite.
- Rate-limit and jitter pulls (be a polite client); back off on any auth error
  rather than retrying into a lockout.

**Phase 4 exit criteria:** aggregator/official-API survey documented with a
go/no-go; if vault is built: Mode U works end-to-end with plaintext never at rest
server-side (verified by code review + log inspection); Mode S (if enabled) has
KEK isolation, audit log, kill switch, and a written threat model; OCR/CSV import
remains fully functional as the fallback.

---

## Sequencing & dependency map

```
Refactor Phase 4 (component split) ──► finish first (Jan's call on timing)
Refactor Phase 5 (IndexedDB)       ──► shared prerequisite ─┐
                                                            ▼
Roadmap P1 (edge data plane + hardening)  ── independent, start any time after refactor
        │  (Worker exists; F8/F9 are day-one tasks)
        ▼
Roadmap P3 (iOS push)      — needs P1's Worker deploy + hardening; small.
Roadmap P2 (cloud sync)    — needs P1's platform decision (1.4) + auth choice; benefits from refactor P5.
        ▼
Roadmap P4 (brokers)       — needs P2's key management + P1's connector patterns. Last, by design.
```

Suggested order of execution: **P1 → P3 → P2 → P4.** (P3 before P2 because it's
mostly verification of existing code and delivers daily value on Jan's phone;
P2 is the larger design commitment; P4 stays last and optional-gated.)

## Standing rules (apply to every phase — from the security-safeguards memory)

1. Never commit secrets; scan staged diffs before commit; anything committed to a
   public repo is public even if the Pages allowlist excludes it.
2. Never push unprompted — pushes trigger the public redeploy; Jan authorizes.
3. Every new runtime asset: add to `static.yml` allowlist **and** Guard-1 **and**
   `SHELL_ASSETS` (+ cache-version bump) in the same change.
4. New Worker secrets go in `wrangler secret put`, never in source.
5. Behavior-affecting change → test pinning current behavior first (the refactor's
   sequencing rule applies to security work too).
6. This document is public once committed: keep Worker URLs, account identifiers,
   and anything fingerprintable out of it.
