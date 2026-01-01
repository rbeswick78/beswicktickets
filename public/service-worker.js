const CACHE_NAME = 'beswick-tickets-cache-v1';
const urlsToCache = [
  '/',
  '/css/style.css',
  '/css/styles.css',
  '/js/main.js',
  '/js/viewportHeight.js',
  '/js/socket.js',
  '/js/ui.js',
  '/socket.io/socket.io.js',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  // Add other assets like images, fonts, and additional scripts
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request);
      })
  );
});