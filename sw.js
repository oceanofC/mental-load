/* Mental Load service worker: offline app shell, reminders, notification taps. */
const CACHE = 'ml-shell-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './vendor/supabase.js',
  './vendor/591.supabase.js',
  './vendor/qrcode.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // fonts: cache-first so the app keeps its look offline
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    event.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return; // the database always goes to the network

  // the page itself: network first so updates land, cached copy when offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Mental Load', {
    body: d.body || '',
    tag: d.tag || 'ml',
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: d.url || './' },
  }));
});

// Chrome can rotate a subscription; get a new one now, and the app re-registers it with the server on next open.
self.addEventListener('pushsubscriptionchange', (event) => {
  const opts = event.oldSubscription && event.oldSubscription.options;
  if (!opts) return;
  event.waitUntil(self.registration.pushManager.subscribe(opts).catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        w.postMessage({ type: 'open', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
