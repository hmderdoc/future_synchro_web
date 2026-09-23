// sw.js — RESCUE / KILL-SWITCH worker.  This is NOT the live service worker.
//
// The live worker is ./sw.ssjs (dynamic, content-hashed manifest), registered
// by every current page.  This file exists only for browsers still holding a
// registration at ./sw.js from before the sw.ssjs switch: those clients (most
// visibly installed PWAs) can be pinned to a stale precached shell that
// predates whole features.  Browsers re-check the registered script URL on
// every navigation (at most 24h apart), so they fetch this worker, install it
// (nothing here can fail — no precache), and it self-destructs: wipe every
// cache for the origin, drop the ./sw.js registration, and reload each open
// window so the fresh page registers ./sw.ssjs.
//
// Do NOT regenerate a full worker at this path — build-sw.sh guards this.

self.addEventListener('install', function () {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        // claim() first: navigate() below only works on controlled windows.
        self.clients.claim().then(function () {
            return caches.keys();
        }).then(function (names) {
            return Promise.all(names.map(function (n) {
                return caches.delete(n);
            }));
        }).then(function () {
            return self.registration.unregister();
        }).then(function () {
            return self.clients.matchAll({ type: 'window' });
        }).then(function (clients) {
            clients.forEach(function (client) {
                // Reload each window off the network; browsers that refuse
                // still recover on their next launch (registration is gone).
                if (client.navigate) {
                    client.navigate(client.url).catch(function () {});
                }
            });
        })
    );
});

// No fetch handler: every request goes straight to the network.
