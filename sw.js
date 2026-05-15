// LPG Summit App — service worker for offline support
// Cache name is versioned via the URL query when registered (?v=APP_VERSION)
// so a new app version triggers a fresh install + old caches get nuked.
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'lpg-summit-' + VERSION;
// Derive BASE from this worker's own pathname (e.g. "/LPG-Summit-App-Test_1/sw.js" → "/LPG-Summit-App-Test_1/")
// so the worker works under any deployment path.
const BASE = new URL('./', self.location.href).pathname;

// Pre-cache the shell on install. Other assets are cached on first fetch.
const SHELL = [
  BASE,
  BASE + 'index.html',
  BASE + 'icon.png',
  BASE + 'icon-192.png',
  BASE + 'manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try { await cache.addAll(SHELL); } catch (_) {}
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

  // Only handle requests within our origin + app path
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(BASE)) return;

  const isShell = url.pathname === BASE || url.pathname === BASE + 'index.html' || url.pathname.endsWith('/index.html');
  const isAsset = /\.(png|jpg|jpeg|gif|svg|webp|woff2?|ttf|css|js)$/i.test(url.pathname);

  if (isShell) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (_) {
        const cached = await caches.match(req) || await caches.match(BASE + 'index.html') || await caches.match(BASE);
        if (cached) return cached;
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
