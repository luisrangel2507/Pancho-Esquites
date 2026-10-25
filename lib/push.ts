import { rpc } from './supabase';

// Registra este teléfono para recibir el aviso de cierre aunque la app esté cerrada.
// Requiere permiso de notificaciones; si algo falla, la app sigue igual (queda el aviso en pantalla).
const b64ToBytes = (s: string) => {
  const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};

export async function enablePush(pass: string) {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const r = await fetch(`${url}/functions/v1/aviso-cierre`, { headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! } });
      if (!r.ok) return;
      const { publicKey } = await r.json();
      if (!publicKey) return;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    }
    const j = sub.toJSON();
    if (j.endpoint && j.keys?.p256dh && j.keys?.auth) {
      await rpc('push_subscribe', { p_pin: pass, p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
    }
  } catch { /* sin soporte o sin la función desplegada todavía */ }
}

// Pide permiso (debe llamarse dentro de un toque del usuario) y registra el teléfono
export async function askPush(pass: string) {
  try {
    if (typeof Notification === 'undefined') return;
    const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (p === 'granted') await enablePush(pass);
  } catch { }
}
