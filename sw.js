// sw.js — Offline Music Player service worker
//
// STRATEGY: network-first for the app shell.
// Every time the device is online, the browser fetches the latest
// index.html / styles.css / app.js from GitHub Pages and updates the
// cache. Only when there is NO network does it fall back to whatever
// was last cached. This is deliberate: it prevents ever getting
// permanently stuck on an old broken version, while still giving full
// offline capability once at least one online visit has happened.
//
// Imported audio files are NEVER touched by this file — they live only
// in IndexedDB (see app.js).

const CACHE_NAME = 'music-player-shell-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests for our own shell files.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Got a fresh copy — update the cache for next time we're offline.
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        return networkResponse;
      })
      .catch(() => {
        // No network — serve from cache instead.
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return undefined;
        });
      })
  );
});
