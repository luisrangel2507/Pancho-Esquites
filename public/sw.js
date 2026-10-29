// Service worker de limpieza: borra lo guardado por versiones anteriores y se desinstala.
// Conserva solo las notificaciones push de cierre de caja.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))).then(() => self.clients.claim())
));
// sin evento "fetch": todo va directo a la red, nada se guarda

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { }
  e.waitUntil(self.registration.showNotification(d.title || 'Pancho Esquites', {
    body: d.body || 'Hay que cerrar la caja.', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'cierre', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(ws => ws.length ? ws[0].focus() : self.clients.openWindow((e.notification.data && e.notification.data.url) || '/')));
});
