// sw.js
// This service worker caches the APP SHELL only (html/css/js/icons/manifest).
// It never touches your imported audio — that lives in IndexedDB, handled in app.js.

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

// Install: pre-cache the shell so the app can load with no network at all.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// Activate: clean up any old cache versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Fetch: serve the shell from cache first, fall back to network.
// Only handle GET requests for our own origin (never intercept anything else).
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => {
        // If offline and it's a navigation request, fall back to index.html
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
