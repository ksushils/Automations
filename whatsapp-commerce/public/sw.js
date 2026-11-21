/* Service worker for the dashboard app: phone notifications (Web Push) and opening the right page on tap. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'New activity', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'New activity', { body: d.body || '', tag: d.tag, icon: '/admin/icon.svg', badge: '/admin/icon.svg', data: { url: d.url || '/admin/' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/admin/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.includes('/admin')) { c.focus(); c.navigate(url).catch(() => {}); return; }
    return self.clients.openWindow(url);
  }));
});
