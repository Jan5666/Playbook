// ─── Playbook Service Worker ─────────────────────────────────────────────────
// Bump CACHE_NAME on every deploy to invalidate the old shell and force
// the browser to install the new worker and re-cache all assets.
const CACHE_NAME = 'playbook-shell-v3';
const CDN_CACHE  = 'playbook-cdn-v1';

// Every file that makes up the app shell. The SW will pre-fetch and store
// all of these during install so the app boots from cache when offline.
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
      .then(() => self.skipWaiting())   // activate immediately, don't wait for old tabs to close
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
      .then(() => self.clients.claim())  // take control of open tabs immediately
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // Same-origin assets (HTML, JS, CSS, icons) → Cache-First
  // The shell is fully pre-cached at install time; cache.put() keeps it fresh
  // on subsequent network hits so any asset missed at install is covered.
  if (url.origin === self.location.origin) {
    e.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  // CDN scripts (React/unpkg) and Google Fonts → Stale-While-Revalidate
  // Serve the cached copy instantly; update the cache in the background.
  if (
    url.hostname === 'unpkg.com' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    e.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  // Everything else (Yahoo Finance API calls, CORS proxies, etc.) → network-only.
  // Live price data should never be served stale.
});

// ─── Cache strategies ─────────────────────────────────────────────────────────

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => {
      if (cached) return cached;
      // Asset wasn't pre-cached (shouldn't normally happen) — fetch and store it.
      return fetch(request).then(response => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      });
    })
  );
}

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(cache =>
    cache.match(request).then(cached => {
      const revalidate = fetch(request)
        .then(response => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);   // network failed → fall back to whatever we have
      return cached || revalidate;
    })
  );
}

// ─── Notifications ────────────────────────────────────────────────────────────

self.addEventListener('message', (e) => {
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
