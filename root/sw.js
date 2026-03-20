// Service Worker for futureland.today PWA
var CACHE_NAME = 'futureland-v11';

// Static assets to pre-cache on install
var PRECACHE_URLS = [
    './',
    './?page=000-home.xjs',
    './css/style.css',
    './css/theme-cga.css',
    './css/spa.css',
    './js/common.js',
    './js/chat.js',
    './js/graphics-converter.js',
    './js/avatars.js',
    './js/bin-icons.js',
    './js/terminal.js',
    './terminal-iframe.html',
    './images/favicon.ico',
    './images/icon-192.png',
    './images/icon-512.png',
    './images/cp437-ibm-vga8.png',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js'
];

// Install: pre-cache shell assets
self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(PRECACHE_URLS);
        }).then(function () {
            return self.skipWaiting();
        })
    );
});

// Activate: clean up old caches
self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(
                names.filter(function (n) { return n !== CACHE_NAME; })
                     .map(function (n) { return caches.delete(n); })
            );
        }).then(function () {
            return self.clients.claim();
        })
    );
});

// Fetch strategy:
//   - API / SSE / POST requests: network only (never cache)
//   - Static assets (js, css, images, fonts): cache-first
//   - HTML pages: network-first with cache fallback
self.addEventListener('fetch', function (event) {
    var url = new URL(event.request.url);

    // Never cache API calls, SSE streams, or non-GET requests
    if (event.request.method !== 'GET') return;
    if (url.pathname.indexOf('/api/') !== -1) return;
    if (url.pathname.indexOf('/events/') !== -1) return;

    // Static assets: cache-first
    if (/\.(js|css|png|jpg|gif|ico|woff2?|ttf|eot|svg)(\?|$)/.test(url.pathname) ||
        url.hostname === 'cdn.jsdelivr.net' ||
        url.hostname === 'unpkg.com') {
        event.respondWith(
            caches.match(event.request).then(function (cached) {
                if (cached) return cached;
                return fetch(event.request).then(function (response) {
                    if (response && response.status === 200) {
                        var clone = response.clone();
                        caches.open(CACHE_NAME).then(function (cache) {
                            cache.put(event.request, clone);
                        });
                    }
                    return response;
                });
            })
        );
        return;
    }

    // HTML / page requests: network-first, fall back to cache
    event.respondWith(
        fetch(event.request).then(function (response) {
            if (response && response.status === 200) {
                var clone = response.clone();
                caches.open(CACHE_NAME).then(function (cache) {
                    cache.put(event.request, clone);
                });
            }
            return response;
        }).catch(function () {
            return caches.match(event.request);
        })
    );
});
