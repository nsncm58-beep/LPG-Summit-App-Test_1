// LPG Summit App — service worker for offline support + push notifications.
// Cache name is versioned via the URL query when registered (?v=APP_VERSION)
// so a new app version triggers a fresh install + old caches get nuked.
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'lpg-summit-' + VERSION;
// Derive BASE from this worker's own pathname (e.g. "/LPG-Summit-App-Test_1/sw.js" → "/LPG-Summit-App-Test_1/")
// so the worker works under any deployment path.
const BASE = new URL('./', self.location.href).pathname;

// ============================================================
// Firebase Cloud Messaging — background push handler.
// Initializes Firebase Messaging inside the worker so FCM can deliver
// notifications even when the app tab is closed. The same firebaseConfig
// from index.html is repeated here because the worker has no DOM access.
// ============================================================
try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: "AIzaSyBJqKXfi7Eko-hBZ3D15I8a1ZA8cirXRI8",
    authDomain: "lpgsummittest-3ea64.firebaseapp.com",
    databaseURL: "https://lpgsummittest-3ea64-default-rtdb.firebaseio.com",
    projectId: "lpgsummittest-3ea64",
    storageBucket: "lpgsummittest-3ea64.firebasestorage.app",
    messagingSenderId: "352075229471",
    appId: "1:352075229471:web:c633eae1a813b20fb7682a"
  });
  const messaging = firebase.messaging();
  // Fires when the app is in the background / closed. Foreground messages
  // are handled by onMessage() in the page itself.
  messaging.onBackgroundMessage((payload) => {
    const n = (payload && payload.notification) || {};
    const data = (payload && payload.data) || {};
    const title = n.title || data.title || 'LPG Summit';
    const body  = n.body  || data.body  || '';
    self.registration.showNotification(title, {
      body: body,
      icon: BASE + 'icon-192.png',
      badge: BASE + 'icon-192.png',
      tag: data.tag || ('lpg-' + Date.now()),
      data: { url: BASE, ...data }
    });
  });
} catch (e) {
  // FCM SDK failed to load (e.g., offline first install). Service worker still
  // works for offline caching; push will be inactive until the SDK loads.
}

// Clicking the notification focuses an existing tab or opens a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || BASE;
  event.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsArr) {
      if (client.url.includes(BASE) && 'focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});

// Pre-cache the shell on install. Other assets are cached on first fetch.
const SHELL = [
  BASE,
  BASE + 'index.html',
  BASE + 'icon.png',
  BASE + 'icon-192.png',
  BASE + 'manifest.json',
];

// The app cannot boot without these CDN scripts. Pre-cache them (and serve
// cache-first) so a flaky or captive-portal connection can't strand a device
// that has loaded the app once. URLs are version-pinned, so cache-first is safe.
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try { await cache.addAll(SHELL); } catch (_) {}
    // cache.put (not addAll) — addAll rejects the opaque responses no-cors fetches return.
    await Promise.all(CDN.map(async (u) => {
      try {
        const r = await fetch(u, { mode: 'no-cors' });
        if (r) await cache.put(u, r);
      } catch (_) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('lpg-summit-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Strategy:
//   - Network-first for index.html and the registration script: always try to get a fresh copy,
//     fall back to cache when offline so the app still boots.
//   - Cache-first for static assets (headshots, logos, icons).
//   - Pass through everything else (Firebase, CDNs) — let the browser/network handle it; if offline,
//     Firebase has its own offline persistence already.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Boot-critical CDN scripts: cache-first (pre-cached at install; URLs are version-pinned).
  if (CDN.includes(req.url)) {
    e.respondWith((async () => {
      const cached = await caches.match(req.url);
      if (cached) return cached;
      const fresh = await fetch(req);
      try { const c = await caches.open(CACHE); c.put(req.url, fresh.clone()); } catch (_) {}
      return fresh;
    })());
    return;
  }

  // Only handle requests within our origin + app path
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(BASE)) return;

  const isShell = url.pathname === BASE || url.pathname === BASE + 'index.html' || url.pathname.endsWith('/index.html');
  const isAsset = /\.(png|jpg|jpeg|gif|svg|webp|woff2?|ttf|css|js)$/i.test(url.pathname);

  if (isShell) {
    e.respondWith((async () => {
      // Network-first, but only wait 3.5s: on a slow connection the cached
      // shell opens instantly while the fresh copy keeps downloading in the
      // background for next launch. No cache yet = keep waiting on network.
      const network = (async () => {
        const fresh = await fetch(req);
        try {
          if (fresh && fresh.ok) { const c = await caches.open(CACHE); c.put(req, fresh.clone()); }
        } catch (_) {}
        return fresh;
      })();
      const settled = await Promise.race([
        network.catch(() => '__fail__'),
        new Promise((res) => setTimeout(() => res('__slow__'), 3500)),
      ]);
      if (settled !== '__fail__' && settled !== '__slow__') return settled;
      const cached = await caches.match(req) || await caches.match(BASE + 'index.html') || await caches.match(BASE);
      if (cached) { network.catch(() => {}); return cached; }
      try { return await network; } catch (_) {
        return new Response('Offline — app shell not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  if (isAsset) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (_) {
        return cached || new Response('', { status: 504 });
      }
    })());
    return;
  }
});
