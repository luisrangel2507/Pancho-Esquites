// Service worker: permite instalar la app y abrirla rápido.
// - Archivos con nombre único (/_next/static) e imágenes: del teléfono primero (no cambian).
// - Páginas: red primero, para tener siempre la versión nueva; sin red, la última guardada.
// Nunca guarda llamadas a Supabase: ventas y datos siempre van directo a la base.
const CACHE = 'pancho-v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

const put = (req, res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; };

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const fixed = url.pathname.startsWith('/_next/static/') || /\.(webp|png|woff2)$/.test(url.pathname);
  if (fixed) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => put(req, res))));
    return;
  }
  e.respondWith(fetch(req).then(res => put(req, res)).catch(() => caches.match(req).then(r => r || caches.match('/'))));
});

// Aviso de cierre de caja (lo manda la función "aviso-cierre" de Supabase a las 9 pm)
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
