# Google Cloud Functions Worker Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloudflare Workers push notification service with Google Cloud Functions, maintaining all existing functionality (HTTP API for subscriptions, cron alert checking, push delivery).

**Architecture:** Create an HTTP Cloud Function that handles both API requests and scheduled checks. The function reads/writes device records to Firestore (replacing Workers KV), uses the same pb-core.js alert logic, and accepts minute-by-minute triggers from Cloud Scheduler via HTTP POST with a secret token.

**Tech Stack:** Node.js 20, Google Cloud Functions, Firestore, Cloud Scheduler, Web Push Protocol (RFC 8291/8292)

## Global Constraints

- Preserve all pb-core.js imports and alert evaluation logic unchanged
- VAPID keys and secrets stored in Google Cloud Secret Manager (never committed)
- Free tier target: <2M invocations/month (1 check/min × 1440 mins × 30 days = 43.2k ✓; leaves room for test pushes and API calls)
- App must update its worker URL configuration once deployed
- Firestore free tier: 1GB storage (plenty for ~5k devices at ~100KB each), 50k reads/day (plenty for 1440/day checks)

---

## Task 1: Google Cloud Project Setup

**Files:**
- Create: `docs/GCP-SETUP.md` (setup guide for you to follow)
- Reference: Existing `backend/worker.js`, `backend/webpush.js`, `backend/gen-vapid.mjs`

**Interfaces:**
- Produces: Google Cloud Project ID, Firestore database, Secret Manager entries for VAPID keys

**Steps:**

- [ ] **Step 1: Verify you have a Google Cloud account**

Go to https://console.cloud.google.com and sign in (create free account if needed). You'll get $300 free trial credit. This plan fits well within free tier.

- [ ] **Step 2: Create a new GCP project**

In Console → Select a project (top left) → New Project → Name it `playbook-alerts` or similar → Create. Note the **Project ID** (you'll need it).

- [ ] **Step 3: Enable required APIs**

Go to APIs & Services → Library. Search for and **Enable** each:
- `Cloud Functions API`
- `Cloud Logging API`
- `Cloud Build API`
- `Firestore API`
- `Cloud Scheduler API`
- `Secret Manager API`

Takes ~2 min per API.

- [ ] **Step 4: Create Firestore database**

Go to Firestore (in left nav) → Create Database → Select region closest to you (or `us-central1`) → Start in **Production Mode** → Create.

Note the database name (usually `(default)` — you'll need it for the function).

- [ ] **Step 5: Create VAPID secrets in Secret Manager**

Go to Secret Manager (in left nav) → Create Secret:
- Name: `playbook-vapid-public`
  Value: (paste your current VAPID public key from backend/gen-vapid.mjs output or your existing `.env`)
- Create Secret
- Repeat for: `playbook-vapid-private` and `playbook-vapid-subject`

You'll reference these by name in the Cloud Function environment.

---

## Task 2: Create Cloud Function Code

**Files:**
- Create: `backend/gcp-functions/index.js`
- Create: `backend/gcp-functions/package.json`
- Create: `backend/gcp-functions/.env.example`
- Reference: `backend/worker.js`, `backend/webpush.js`, `pb-core.js`

**Interfaces:**
- Consumes: pb-core.js (marketOpen, evaluateAlerts, SESSIONS, yahooSymbol, centDivisor), webpush.js (sendPush)
- Produces: HTTP Cloud Function that handles `/subscribe`, `/sync`, `/unsubscribe`, `/test`, `/backup`, `/health`, `/vapid-public-key` + scheduled alert checking via `?_schedule=1` query param

**Steps:**

- [ ] **Step 1: Create package.json**

Create `backend/gcp-functions/package.json`:

```json
{
  "name": "playbook-alerts-gcp",
  "version": "1.0.0",
  "runtime": "nodejs20",
  "main": "index.js",
  "dependencies": {
    "@google-cloud/firestore": "^7.5.0",
    "@google-cloud/secret-manager": "^4.2.0"
  },
  "engines": {
    "node": "20.x"
  }
}
```

- [ ] **Step 2: Create the Cloud Function main file**

Create `backend/gcp-functions/index.js`. This adapts `worker.js` to use Firestore instead of Workers KV:

```javascript
// ─── Playbook push backend (Google Cloud Functions) ──────────────────
// Equivalent to Cloudflare Worker, but using Firestore for storage
// and Cloud Scheduler for the minute-by-minute alert checks.
//
// Handles:
//   • HTTP endpoints: /subscribe, /sync, /unsubscribe, /test, /backup, /vapid-public-key
//   • Scheduled checks: triggered by Cloud Scheduler via ?_schedule=1
//
// State lives in Firestore, one document per device (collection "devices").
// ────────────────────────────────────────────────────────────────────────

import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { sendPush } from '../webpush.js';
import PBCore from '../../pb-core.js';

const { marketOpen, evaluateAlerts: evaluate, SESSIONS, yahooSymbol, centDivisor } = PBCore;

const MAX_TRIGGER_HISTORY = 100;
const ACTIVE_SUPPRESS_MS = 90 * 1000;
const CLIENT_TTL_MS = 120 * 24 * 3600 * 1000;

const db = new Firestore({
  projectId: process.env.GCP_PROJECT_ID,
  databaseId: process.env.FIRESTORE_DB || '(default)'
});

const secretClient = new SecretManagerServiceClient();

// ─── Secret loading ──────────────────────────────────────────────────
let vapidKeys = null;

async function getVapidKeys() {
  if (vapidKeys) return vapidKeys;
  
  const projectId = process.env.GCP_PROJECT_ID;
  try {
    const [publicSecret] = await secretClient.accessSecretVersion({
      name: `projects/${projectId}/secrets/playbook-vapid-public/versions/latest`
    });
    const [privateSecret] = await secretClient.accessSecretVersion({
      name: `projects/${projectId}/secrets/playbook-vapid-private/versions/latest`
    });
    const [subjectSecret] = await secretClient.accessSecretVersion({
      name: `projects/${projectId}/secrets/playbook-vapid-subject/versions/latest`
    });
    
    vapidKeys = {
      public: publicSecret.payload.data.toString(),
      private: privateSecret.payload.data.toString(),
      subject: subjectSecret.payload.data.toString()
    };
    return vapidKeys;
  } catch (err) {
    console.error('Failed to load VAPID secrets:', err);
    throw new Error('VAPID keys not configured');
  }
}

// ─── HTTP handlers ───────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const json = (obj, status = 200) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(obj)
});

async function handleHttpRequest(req) {
  if (req.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }

  const path = (req.path || req.url || '/').replace(/\/+$/, '') || '/';

  if (path === '/' || path === '/health') {
    return json({ ok: true, service: 'playbook-push-gcp' });
  }

  try {
    const vapid = await getVapidKeys();

    if (path === '/vapid-public-key' && req.method === 'GET') {
      return json({ publicKey: vapid.public });
    }

    if (path === '/backup') {
      return handleBackup(req);
    }

    if (req.method === 'POST') {
      let body = {};
      if (req.body) {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      }

      const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : '';
      if (!clientId) return json({ error: 'clientId required' }, 400);

      if (path === '/subscribe') {
        if (!body.subscription?.endpoint || !body.subscription?.keys?.p256dh)
          return json({ error: 'bad subscription' }, 400);
        
        const docRef = db.collection('devices').doc(clientId);
        const prev = (await docRef.get()).data() || {};
        await docRef.set({
          ...prev,
          subscription: body.subscription,
          alerts: sanitizeAlerts(body.alerts ?? prev.alerts ?? []),
          seen: prev.seen || {},
          lastActiveAt: Date.now(),
          updatedAt: Date.now()
        });
        return json({ ok: true });
      }

      if (path === '/sync') {
        const docRef = db.collection('devices').doc(clientId);
        const prev = (await docRef.get()).data();
        if (!prev) return json({ ok: false, reason: 'not-subscribed' }, 400);
        
        const next = { ...prev, lastActiveAt: Date.now(), updatedAt: Date.now() };
        if (Array.isArray(body.alerts)) next.alerts = sanitizeAlerts(body.alerts);
        if (body.subscription?.endpoint) next.subscription = body.subscription;
        await docRef.set(next);
        return json({ ok: true });
      }

      if (path === '/unsubscribe') {
        await db.collection('devices').doc(clientId).delete();
        return json({ ok: true });
      }

      if (path === '/test') {
        const doc = await db.collection('devices').doc(clientId).get();
        if (!doc.exists || !doc.data().subscription)
          return json({ error: 'not-subscribed' }, 404);
        
        const status = await pushTo(doc.data().subscription, {
          title: 'Playbook',
          body: 'Background push is connected ✓',
          tag: 'pb-test',
          data: { url: '/' }
        }, vapid).catch(() => 0);
        return json({ ok: status >= 200 && status < 300, status });
      }
    }

    return json({ error: 'not found' }, 404);
  } catch (err) {
    console.error('HTTP error:', err);
    return json({ error: 'internal error' }, 500);
  }
}

// ─── Backup endpoints ────────────────────────────────────────────────
async function handleBackup(req) {
  const validKey = k => typeof k === 'string' && /^[a-f0-9]{32,128}$/.test(k);
  
  if (req.method === 'GET') {
    const key = new URL(req.url, 'http://localhost').searchParams.get('key') || '';
    if (!validKey(key)) return json({ error: 'bad key' }, 400);
    
    try {
      const doc = await db.collection('backups').doc(key).get();
      if (!doc.exists) return json({ error: 'not found' }, 404);
      return json(doc.data());
    } catch (err) {
      return json({ error: 'not found' }, 404);
    }
  }

  if (req.method === 'POST') {
    let body = {};
    if (req.body) {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    }
    
    if (!validKey(body.key)) return json({ error: 'bad key' }, 400);
    const b = body.blob;
    if (!b || typeof b !== 'object' || typeof b.ct !== 'string' || typeof b.iv !== 'string' || typeof b.salt !== 'string')
      return json({ error: 'bad blob' }, 400);
    if (b.ct.length > 6_000_000) return json({ error: 'too large' }, 413);

    try {
      await db.collection('backups').doc(body.key).set({
        blob: b,
        updatedAt: Date.now()
      });
      return json({ ok: true, updatedAt: Date.now() });
    } catch (err) {
      return json({ error: 'write failed' }, 500);
    }
  }

  return json({ error: 'method not allowed' }, 405);
}

// ─── Scheduler invocation (called via Cloud Scheduler HTTP trigger) ──
async function runChecks() {
  try {
    const vapid = await getVapidKeys();
    const now = Date.now();
    
    const snapshot = await db.collection('devices').get();
    
    for (const doc of snapshot.docs) {
      try {
        await checkClient(doc.id, doc.data(), now, vapid);
      } catch (err) {
        console.error(`Error checking device ${doc.id}:`, err);
      }
    }
  } catch (err) {
    console.error('runChecks failed:', err);
  }
}

async function checkClient(clientId, rec, now, vapid) {
  if (!rec || !rec.subscription) return;

  // Garbage-collect long-silent devices.
  if (rec.updatedAt && now - rec.updatedAt > CLIENT_TTL_MS) {
    await db.collection('devices').doc(clientId).delete();
    return;
  }

  const active = (rec.alerts || []).filter(a => a.active && marketOpen(a.market));
  if (active.length === 0) return;

  const want = new Map();
  for (const a of active) want.set(a.market + ':' + a.ticker, a);
  
  const prices = {};
  await Promise.all([...want.values()].map(async a => {
    const px = await fetchQuote(a.ticker, a.market);
    if (px != null) prices[a.market + ':' + a.ticker] = px;
  }));

  const { nextSeen, newTriggers, changed } = evaluate(rec.alerts || [], prices, rec.seen || {});
  if (!changed) return;

  const appActive = rec.lastActiveAt && (now - rec.lastActiveAt) < ACTIVE_SUPPRESS_MS;

  const history = [...newTriggers, ...(rec.bgTriggered || [])].slice(0, MAX_TRIGGER_HISTORY);
  await db.collection('devices').doc(clientId).update({
    seen: nextSeen,
    bgTriggered: history,
    lastCheck: now
  });

  if (appActive) return;

  let gone = false;
  for (const t of newTriggers) {
    const sym = (t.market === 'JSE' || t.market === 'TFSA') ? 'R' : '$';
    const status = await pushTo(rec.subscription, {
      title: `${t.ticker} ${t.direction} ${sym}${t.targetPrice.toFixed(2)}`,
      body: `Now at ${sym}${t.triggerPrice.toFixed(2)}${t.note ? ` — ${t.note}` : ''}`,
      tag: 'alert-' + t.id,
      data: { url: '/', ticker: t.ticker, market: t.market }
    }, vapid).catch(() => 0);
    if (status === 404 || status === 410) gone = true;
  }
  if (gone) await db.collection('devices').doc(clientId).delete();
}

// ─── Quote fetching ──────────────────────────────────────────────────
const PROXIES = [
  u => u,
  u => `https://corsmirror.com/v1?url=${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`
];

async function fetchQuote(ticker, market) {
  const sym = yahooSymbol(ticker, market);
  for (const host of ['query1', 'query2']) {
    const base = `https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d&includePrePost=true`;
    for (const build of PROXIES) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(build(base), {
          cache: 'no-store',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        clearTimeout(t);
        if (!res.ok) continue;
        const meta = (await res.json())?.chart?.result?.[0]?.meta;
        const px = meta?.regularMarketPrice;
        if (typeof px === 'number' && isFinite(px)) return px / centDivisor(market, meta.currency);
      } catch (_e) {}
    }
  }
  return null;
}

function pushTo(subscription, payload, vapid) {
  return sendPush(subscription, payload, {
    publicKey: vapid.public,
    privateKey: vapid.private,
    subject: vapid.subject
  });
}

function sanitizeAlerts(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200)
    .map(a => ({
      id: String(a.id),
      ticker: String(a.ticker || '').toUpperCase().slice(0, 20),
      market: String(a.market || 'US').slice(0, 6),
      direction: a.direction === 'below' ? 'below' : 'above',
      targetPrice: Number(a.targetPrice),
      active: a.active !== false,
      note: a.note ? String(a.note).slice(0, 120) : ''
    }))
    .filter(a => a.id && a.ticker && isFinite(a.targetPrice));
}

// ─── Cloud Functions entry point ─────────────────────────────────────
export const pushWorker = async (req, res) => {
  // Check if this is a scheduled invocation from Cloud Scheduler
  if (req.query._schedule === '1' || req.body?._schedule === '1') {
    // Verify the scheduled request secret
    const secret = req.headers['x-scheduler-secret'] || req.body?.schedulerSecret || '';
    if (secret !== process.env.SCHEDULER_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    await runChecks();
    return res.status(200).json({ ok: true, message: 'checks run' });
  }

  // Otherwise, handle as HTTP API request
  const result = await handleHttpRequest({
    method: req.method,
    path: req.path,
    url: req.url,
    body: req.body,
    headers: req.headers
  });

  res.status(result.statusCode).set(result.headers).send(result.body ? JSON.parse(result.body) : null);
};
```

- [ ] **Step 3: Create .env.example for reference**

Create `backend/gcp-functions/.env.example`:

```bash
# Google Cloud configuration
GCP_PROJECT_ID=your-project-id
FIRESTORE_DB=(default)

# VAPID keys (stored in Secret Manager, not in env)
# Reference Secret Manager names:
# - playbook-vapid-public
# - playbook-vapid-private
# - playbook-vapid-subject

# Security: Random 32+ char secret for Cloud Scheduler requests
SCHEDULER_SECRET=your-random-secret-here-min-32-chars
```

---

## Task 3: Deploy Cloud Function

**Files:**
- Reference: `backend/gcp-functions/index.js`, `backend/gcp-functions/package.json`
- Create: `docs/GCP-DEPLOYMENT.md` (instructions you'll follow)

**Interfaces:**
- Consumes: Completed Cloud Function code from Task 2, GCP Project from Task 1
- Produces: Deployed Cloud Function URL (looks like `https://REGION-PROJECT_ID.cloudfunctions.net/pushWorker`)

**Steps:**

- [ ] **Step 1: Install gcloud CLI**

Download and install gcloud CLI: https://cloud.google.com/sdk/docs/install

Then run:
```bash
gcloud init
# Authenticate with your Google account
# Select your project ID (from Task 1)
```

- [ ] **Step 2: Deploy the function**

From your project root, run:
```bash
gcloud functions deploy pushWorker \
  --gen2 \
  --runtime nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point pushWorker \
  --source backend/gcp-functions \
  --set-env-vars GCP_PROJECT_ID=$(gcloud config get-value project),SCHEDULER_SECRET=$(openssl rand -hex 16),FIRESTORE_DB='(default)' \
  --region us-central1
```

After deployment, the output will show:
```
Trigger URL: https://us-central1-PROJECT_ID.cloudfunctions.net/pushWorker
```

**Save this URL** — you'll need it for the next tasks.

- [ ] **Step 3: Set SCHEDULER_SECRET in Secret Manager**

Generate a random secret and store it:
```bash
SCHEDULER_SECRET=$(openssl rand -hex 16)
echo -n "$SCHEDULER_SECRET" | gcloud secrets create playbook-scheduler-secret --data-file=-
gcloud functions deploy pushWorker \
  --gen2 \
  --runtime nodejs20 \
  --update-env-vars SCHEDULER_SECRET=$SCHEDULER_SECRET \
  --region us-central1
```

---

## Task 4: Set Up Cloud Scheduler

**Files:**
- Reference: Deployed Cloud Function URL from Task 3

**Interfaces:**
- Consumes: Cloud Function URL, SCHEDULER_SECRET
- Produces: Cloud Scheduler job running every minute

**Steps:**

- [ ] **Step 1: Create Cloud Scheduler job**

Go to Cloud Scheduler (in GCP Console left nav) → Create Job:
- Name: `playbook-alerts-check`
- Frequency: `* * * * *` (every minute)
- Timezone: Your timezone or UTC
- Execution timeout: 600 seconds
- Click **Create**

- [ ] **Step 2: Configure HTTP target**

Click the job name → Edit → Configure the HTTP request:
- URL: (paste your Cloud Function URL from Task 3)
- HTTP Method: POST
- Headers:
  - Key: `x-scheduler-secret`
  - Value: (your SCHEDULER_SECRET from Task 3)
- Click **Save**

- [ ] **Step 3: Test the scheduler**

Go back to the Cloud Scheduler job → Click **Force Run** (top right). After ~10 seconds, check:
```bash
gcloud functions logs read pushWorker --region us-central1 --limit 10
```

You should see:
```
runChecks completed
```

---

## Task 5: Create Firestore Indexes (if needed)

**Files:**
- Reference: `backend/gcp-functions/index.js`

**Interfaces:**
- Consumes: Deployed Cloud Function, Firestore collections
- Produces: Firestore queries working efficiently

**Steps:**

- [ ] **Step 1: Check if indexes are needed**

For now, the queries are simple (single collection, no complex filters). Firestore will auto-create any needed indexes. If you see a warning in logs about missing indexes, go to Firestore → Indexes and create as suggested.

No action needed at this stage unless you see index warnings.

---

## Task 6: Wire App to New Worker URL

**Files:**
- Modify: `app/js/app.js` or wherever `PUSH_WORKER_URL` is set
- Reference: Cloud Function URL from Task 3

**Interfaces:**
- Consumes: Deployed Cloud Function URL
- Produces: App configured to use new worker

**Steps:**

- [ ] **Step 1: Find current worker config**

In `app.js` (or app root), find where the Cloudflare Worker URL is set. It likely looks like:
```javascript
const PUSH_WORKER_URL = 'https://playbook-push.<your>.workers.dev';
```

- [ ] **Step 2: Update to new URL**

Replace with your Google Cloud Function URL:
```javascript
const PUSH_WORKER_URL = 'https://us-central1-PROJECT_ID.cloudfunctions.net/pushWorker';
```

- [ ] **Step 3: Test in the app**

Start the app locally and navigate to Settings → Background Push. Click **Test Push**. You should receive a test notification within 10 seconds.

- [ ] **Step 4: Commit**

```bash
git add app/js/app.js docs/GCP-*.md backend/gcp-functions/
git commit -m "feat: migrate push worker from Cloudflare to Google Cloud Functions"
```

---

## Task 7: Verify Full Alert Flow

**Files:**
- Reference: `backend/gcp-functions/index.js`, app.js

**Interfaces:**
- Consumes: Deployed Cloud Function, scheduled trigger, app with new URL
- Produces: Verified end-to-end alert workflow

**Steps:**

- [ ] **Step 1: Check Cloud Function logs**

```bash
gcloud functions logs read pushWorker --region us-central1 --limit 20
```

Look for:
- `/subscribe` calls (app registering)
- `/sync` calls (app sending alert updates)
- `runChecks completed` (scheduler running successfully)
- No errors

- [ ] **Step 2: Test push delivery**

Open the app → Settings → Background Push → **Test Push**. You should receive a notification in ~3 seconds.

If it fails, check:
- `gcloud functions logs read pushWorker --region us-central1 --limit 50` for errors
- VAPID keys are correctly stored in Secret Manager
- Browser has granted notification permission

- [ ] **Step 3: Create a real alert and verify trigger**

Set a price alert on a stock you own (e.g., alert if VOO goes +/- $1). Wait for market to be open. Within 60 seconds of the next Cloud Scheduler trigger, you should get a push notification if the price moved enough.

Check logs:
```bash
gcloud functions logs read pushWorker --region us-central1 --limit 20
```

Should show alert evaluation logs.

- [ ] **Step 4: Monitor costs**

Go to GCP Console → Billing. You should see:
- Cloud Functions: < $0.20/month (well within free tier)
- Firestore: < $1/month (within free tier)
- Cloud Scheduler: free (3 jobs free)

---

## Summary of Configuration Needed After Deployment

Once all tasks are complete, you'll have:

1. **Cloud Function URL** (e.g., `https://us-central1-PROJECT_ID.cloudfunctions.net/pushWorker`)
2. **VAPID keys** stored in Secret Manager (not in code)
3. **SCHEDULER_SECRET** for Cloud Scheduler authentication
4. **Firestore database** with two collections:
   - `devices` — one doc per phone/subscription
   - `backups` — encrypted portfolio backups

**The app needs only one change:** point `PUSH_WORKER_URL` to the new Cloud Function URL.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-01-gcp-worker-migration.md`.

## Next Steps

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch fresh subagents per task with review checkpoints between each. Faster iteration, good for complex tasks where you need validation.

**2. Inline Execution** — I execute tasks sequentially in this session with your input at checkpoints.

Which approach would you prefer?