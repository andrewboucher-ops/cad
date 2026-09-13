// CCCS service worker — exists only to receive Web Push while the console
// isn't open (locked phone, app in the background) and turn it into a system
// notification. It does not cache anything or work offline; the console
// already has its own offline queue in app.js for that.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'CCCS', body: 'Update from control', url: '/' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* keep the default */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag || 'cccs',
      renotify: true,
      requireInteraction: data.tag === 'cccs-emergency',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (new URL(c.url).pathname === url && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
