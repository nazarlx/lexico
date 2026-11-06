/* Offline shell cache. Bump CACHE on every release so clients pick up new assets. */

const CACHE = 'lexico-v11';
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './icon.svg',
  './manifest.webmanifest',
];
/* seed.json is ~1 MB — cached lazily on first use rather than at install,
   so a fresh install stays fast for users who never load the starter pack. */

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API traffic, and never intercept cross-origin requests.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Cache-first for the app shell, with a background refresh.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fetching = fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || fetching;
    })
  );
});
