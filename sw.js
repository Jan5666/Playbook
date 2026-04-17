// Playbook Service Worker
const CACHE = 'playbook-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Cache-first for app shell, network-first for everything else
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && (url.pathname === '/' || url.pathname.endsWith('index.html'))) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        fetch(e.request).then(res => {
          cache.put(e.request, res.clone());
          return res;
        }).catch(() => cache.match(e.request))
      )
    );
  }
});

// Receive messages from the page to fire notifications
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

// Push event (for future server-side push integration)
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = data.title || 'Playbook alert';
  const opts = {
    body: data.body || '',
    tag: data.tag || 'playbook-push',
    data: data.data || { url: '/' },
    vibrate: [100, 50, 100]
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});
