/*
 * Service worker for the installed web build.
 *
 * "Offline" here is not a fallback: the app must keep working with the network
 * disabled and the local server not running. Nothing has to tell this worker
 * about a file — every byte the app can ask for goes through the `fetch`
 * handler below, which fills the cache as it serves it. The install step caches
 * the shell *and* the content packs, because the web shell re-reads its corpus
 * from its own origin on every load (see `desktop/src/gateway/devGateway.ts`:
 * `autoImport`), so an offline start has to be able to read every pack. Filling
 * on first read is the backstop, never the plan.
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
 *
 * Two rules this file learned the hard way, and they are load-bearing:
 *  1. a cache write is buffered, awaited and done BEFORE the response is handed
 *     to the page. The first version of this worker wrote
 *     `caches.open().then(c => c.put())` with a cloned response and returned the
 *     original immediately; for a 3 KB file that looked fine, for the 18 MB
 *     `word-data/payload.jsonl` the worker went idle while the clone was still
 *     streaming and the write was dropped in silence. Handing the cache a clone
 *     of a large streamed response is still not reliable: measured on this
 *     machine, `Cache.put()` answered
 *     `NetworkError: Failed to execute 'put' on 'Cache': Cache.put()
 *     encountered a network error` for exactly that one file, while every
 *     smaller pack went in. Reading the body to bytes once, then building both
 *     the cached copy and the page's response from those bytes, is what made it
 *     work. An offline start that cannot re-read `word-data` is not offline, so
 *     nothing may resolve `respondWith` before the bytes it promised to store
 *     are stored.
 *  2. `VERSION` is bumped whenever the shipped content or these rules change,
 *     because a client holding a cache written by an older rule must not inherit
 *     it: `activate` deletes every other cache.
 */

const VERSION = 'quran-web-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/pwa-192.png',
  './icons/pwa-256.png',
  './icons/pwa-512.png',
];
const CONTENT_INDEX = './content/index.json';

/**
 * The pack files as the shipped data describes them: whatever `index.json`
 * lists is cached, so a ninth pack can never be forgotten in this file. The
 * folder name is the pack id — the same rule `contentMiddleware.mjs`,
 * `packSource.ts` and `stageContent.mjs` apply.
 */
async function packFiles() {
  try {
    const res = await fetch(CONTENT_INDEX, { cache: 'no-store' });
    if (!res.ok) return [];
    const index = await res.json();
    const packs = Array.isArray(index && index.packs) ? index.packs : [];
    return packs
      .filter((pack) => pack && typeof pack.id === 'string' && /^[a-z0-9-]+$/i.test(pack.id))
      .flatMap((pack) => [`./content/${pack.id}/pack.json`, `./content/${pack.id}/payload.jsonl`]);
  } catch {
    return [];
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // The shell is the right to boot at all: a missing shell file is a broken
      // build, so this one is allowed to fail the install loudly.
      await cache.addAll(SHELL);
      await cache.add(CONTENT_INDEX).catch(() => undefined);
      for (const file of await packFiles()) {
        // Roughly 30 MB of packs. One at a time, and a single failure is a
        // warning rather than a dead install: the fetch handler fills whatever
        // the app reads later.
        try {
          const res = await fetch(file, { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await cache.put(file, await toStoredResponse(res));
        } catch (error) {
          console.warn('[sw] pack not precached:', file, error);
        }
      }
      await self.skipWaiting();
    })(),
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

/**
 * Read a response to bytes and hand back a response built from them, so the
 * same bytes can be stored and served without anyone racing a stream. See rule 1
 * in the header: this is the difference between an offline start that can read
 * `word-data` and one that cannot.
 */
async function toStoredResponse(response) {
  const bytes = await response.arrayBuffer();
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

/** Store first, answer second, from one buffer: see rule 1 in the header. */
async function fillAndReturn(cache, request, response) {
  if (!response || !response.ok) return response;
  let bytes;
  let init;
  try {
    bytes = await response.arrayBuffer();
    init = { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) };
    await cache.put(request, new Response(bytes, init));
  } catch (error) {
    console.warn('[sw] could not cache', request.url, error);
    // The body was already consumed by the attempt above, so this response can
    // no longer be played back. Failing here is the honest outcome: it is what
    // would have happened on the next offline start anyway, and it is a warning
    // in the worker console rather than a silent hole in the cache.
    throw error;
  }
  return new Response(bytes, init);
}

async function handle(event) {
  const request = event.request;
  const cache = await caches.open(VERSION);

  if (request.mode === 'navigate') {
    try {
      return await fillAndReturn(cache, './index.html', await fetch(request));
    } catch {
      const cached = await cache.match('./index.html');
      if (cached) return cached;
      throw new Error('offline, and the app shell was never cached');
    }
  }

  const hit = await cache.match(request);
  if (hit) return hit;
  return fillAndReturn(cache, request, await fetch(request));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(handle(event).catch(async (error) => {
    console.warn('[sw] unhandled request', request.url, error);
    const fallback = await caches.match(request);
    if (fallback) return fallback;
    throw error;
  }));
});
