// ─── Playbook Service Worker ─────────────────────────────────────────────────
const CACHE_NAME   = 'playbook-shell-v9';
const CDN_CACHE    = 'playbook-cdn-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

// ─── Install: pre-cache the entire app shell ──────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: purge every cache that isn't ours ─────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CDN_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // Same-origin assets → Network-First
  // Always try the network so deploys take effect immediately.
  // Fall back to cache only when offline.
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(request, CACHE_NAME));
    return;
  }

  // CDN scripts (React/unpkg) and Google Fonts → Stale-While-Revalidate
  if (
    url.hostname === 'unpkg.com' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    e.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  // Everything else (API calls) → network-only
});

// ─── Cache strategies ─────────────────────────────────────────────────────────

function networkFirst(request, cacheName) {
  return fetch(request)
    .then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(cacheName).then(cache => cache.put(request, clone));
      }
      return response;
    })
    .catch(() => caches.open(cacheName).then(cache => cache.match(request)));
}

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => {
      const revalidate = fetch(request)
        .then(response => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || revalidate;
    })
  );
}

// ─── Update messaging ─────────────────────────────────────────────────────────
// When the app calls postMessage({ type: 'SKIP_WAITING' }), activate immediately.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (e.data && e.data.type === 'notify') {
    self.registration.showNotification(e.data.title || 'Playbook', {
      body: e.data.body || '',
      tag: e.data.tag || 'playbook',
      icon: e.data.icon,
      badge: e.data.badge,
      data: e.data.data || { url: '/' },
      vibrate: [100, 50, 100],
      requireInteraction: false
    });
  }
});

// ─── Notifications ────────────────────────────────────────────────────────────

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'Playbook alert', {
      body: data.body || '',
      tag: data.tag || 'playbook-push',
      data: data.data || { url: '/' },
      vibrate: [100, 50, 100]
    })
  );
});
