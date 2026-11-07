// CCCS service worker — receives Web Push while the console isn't open
// (locked phone, app in the background) and turns it into a system
// notification, and keeps a copy of the app's own files so the officer app
// still opens with no signal.
//
// Only the app's files are kept (pages, scripts, styles, icons): never
// /api/ or /ws, so no data lives here and nothing here is ever shown in
// place of live data. Always network first: a copy is only used when the
// network fails, so a deploy is picked up on the next load with signal.

const SHELL = 'cccs-shell-v1';
const PRECACHE = ['/officer.html', '/index.html', '/app.js', '/nav.js', '/forms-ui.js', '/console.css', '/theme-init.js', '/manifest.json', '/icon-192.png', '/favicon.svg', '/vendor/jsQR.js'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL).then((c) => Promise.all(PRECACHE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('cccs-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

const keepable = (url) => url.origin === self.location.origin && !url.pathname.startsWith('/api/') && url.pathname !== '/ws' && /\.(html|js|css|png|svg|ico|json|woff2?)$|\/$/.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!keepable(url)) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(url.pathname, copy)).catch(() => {}); }
      return res;
    } catch (e) {
      // Signal is gone: the saved copy, matched on the path alone so
      // /officer.html#job and /officer.html?x both find it.
      const hit = await caches.match(url.pathname, { cacheName: SHELL });
      if (hit) return hit;
      throw e;
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = { title: 'CCCS', body: 'Update from control', url: '/' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* keep the default */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
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
