/* sw-push.js - native push handling, appended to the live service worker by
   sw.ssjs. Payloads come from mods/push/push_daemon.js:
   { title, body, url, tag, kind, icon? }. icon is the sender's avatar,
   drawn by the daemon (mods/push/avatar_png.js); the site icon otherwise. */

self.addEventListener('push', function (event) {
    var data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
    event.waitUntil(self.registration.showNotification(data.title || 'Futureland', {
        body: data.body || '',
        icon: data.icon || './images/icon-192.png',
        badge: './images/icon-maskable-192.png',
        tag: data.tag || undefined,
        data: { url: data.url || './' }
    }));
});

/* Open the link: reuse a site window if one is open, else open one. */
self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
        for (var i = 0; i < windows.length; i++) {
            var w = windows[i];
            if (new URL(w.url).origin === new URL(target).origin && w.navigate) {
                return w.focus().then(function (focused) { return (focused || w).navigate(target); });
            }
        }
        return self.clients.openWindow(target);
    }));
});
