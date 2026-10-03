// eisenmail service worker: push notifications only.
// It deliberately has no fetch handler and caches nothing: mail is private and must never be
// written to a browser cache, and without caching there is no stale-app problem either.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Only ever navigate to a path on this site.
function safePath(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/mail';
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = String(data.title || 'New mail').slice(0, 120);
  const options = {
    body: [String(data.body || '').slice(0, 300), data.address ? 'to ' + String(data.address).slice(0, 120) : ''].filter(Boolean).join('\n'),
    tag: data.tag ? String(data.tag).slice(0, 100) : undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: safePath(data.url) },
  };
  const work = [self.registration.showNotification(title, options)];
  // The unread count on the home screen icon. The server sends it with the notification; without
  // one, show a plain dot. The app sets the exact number again whenever it is opened.
  if (self.navigator.setAppBadge) {
    const count = Number.isInteger(data.badge) && data.badge > 0 ? data.badge : undefined;
    work.push(self.navigator.setAppBadge(count).catch(() => {}));
  }
  event.waitUntil(Promise.all(work));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        // An open app window: bring it forward and let the app route to the message list.
        client.postMessage({ type: 'eisenmail:navigate', url });
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
