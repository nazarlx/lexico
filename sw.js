/* Offline cache.
 *
 * The app shell is network-first on purpose. A cache-first shell meant every
 * fix shipped had to wait for a second reload — the old worker kept serving the
 * old app.js — so broken data stayed on screen even after it was fixed on the
 * server. Now a fresh app.js wins whenever the network answers, and the cache
 * is only the offline fallback. Data files stay cache-first: they are large,
 * change rarely, and are revalidated in the background.
 */

const CACHE = 'lexico-v13';

const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './icon.svg',
  './manifest.webmanifest',
];

/* Large, rarely-changing payloads: serve fast from cache, refresh behind the scenes. */
const DATA = /\/(seed|phrases)\.json$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (DATA.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(e.request));
  } else {
    e.respondWith(networkFirst(e.request));
  }
});

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
    }
    return res;
  } catch {
    const hit = await caches.match(request);
    // navigations must still resolve offline, even for a deep link
    return hit || (await caches.match('./index.html')) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const hit = await caches.match(request);
  const fetching = fetch(request)
    .then((res) => {
      if (res && res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
      return res;
    })
    .catch(() => hit);
  return hit || fetching;
}
