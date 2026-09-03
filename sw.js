// 75 Hard Tracker — service worker
// Only job: receive push events and show a notification. No offline caching
// (deliberately no fetch handler) — this app is small and always wants fresh
// data, and caching would just be a source of stale-content bugs to debug.

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var title = data.title || '75 Hard';
  var options = {
    body: data.body || 'Stay locked in.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: '75hard-daily-reminder',
    renotify: true,
    data: { url: '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if ('focus' in clientList[i]) return clientList[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
