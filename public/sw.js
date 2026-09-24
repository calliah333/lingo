// Lingo service worker: shows Web Push notifications and routes clicks back to the app.
// Payloads follow `PushNotification` in src/shared/contracts.ts.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { bufferId: null, title: 'Lingo', body: 'New notification' };
  }
  const bufferId = typeof data.bufferId === 'number' ? data.bufferId : null;
  event.waitUntil(self.registration.showNotification(String(data.title || 'Lingo'), {
    body: String(data.body || ''),
    // Repeats for one buffer replace each other instead of stacking up.
    tag: bufferId === null ? 'lingo-test' : `lingo-buffer-${bufferId}`,
    renotify: true,
    icon: '/icon-192.png',
    data: { bufferId },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const bufferId = event.notification.data?.bufferId ?? null;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      if (bufferId !== null) open.postMessage({ type: 'open-buffer', bufferId });
      return;
    }
    await self.clients.openWindow(bufferId === null ? '/' : `/?buffer=${bufferId}`);
  })());
});
