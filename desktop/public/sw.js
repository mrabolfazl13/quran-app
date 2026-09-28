/*
 * Service worker for the installed web build.
 *
 * "Offline" here is not a fallback: the app must keep working with the network
 * disabled and the local server not running. Nothing has to tell this worker
 * about a file — every byte the app can ask for goes through the `fetch`
 * handler below, which fills the cache as it serves it. The install step caches
 * the shell so a first run has something to load; the packs enter the cache the
 * first time the app reads them, which is the same request that imports them.
 *
 * Strategies, and why:
 *  - navigations: network-first. A machine that re-runs the installer must get
 *    the new app; one that does not must still open the old one from cache.
 *  - /assets/*: cache-first. Vite fingerprints these names, so a hit is always
 *    the same bytes and a miss can never be stale.
 *  - /content/*: cache-first, then fill. Packs are re-staged per build under the
 *    same names, so `VERSION` is what invalidates them, not the URL.
 *  - anything else same-origin GET: cache, then network.
 * Cross-origin requests are never made by this app and are never proxied.
 */

const VERSION = 'quran-web-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/pwa-192.png',
  './icons/pwa-256.png',
  './icons/pwa-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
    }),
  );
});
