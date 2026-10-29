// Avisos push de cierre de caja: llaves VAPID, registro de teléfonos y el aviso de las 9 pm (03:00 UTC)
import webpush from 'web-push';
import { pool } from './db.mjs';

async function keys() {
  let { rows: [c] } = await pool.query(`select vapid_public, vapid_private from push_config where id = 1`);
  if (!c?.vapid_public || !c?.vapid_private) {
    const k = webpush.generateVAPIDKeys();
    // solo la primera escritura gana; si dos arranques coinciden, el segundo relee
    await pool.query(`update push_config set vapid_public = $1, vapid_private = $2 where id = 1 and vapid_public is null`, [k.publicKey, k.privateKey]);
    ({ rows: [c] } = await pool.query(`select vapid_public, vapid_private from push_config where id = 1`));
  }
  return c;
}
export async function publicKey() { return (await keys()).vapid_public; }

export async function sendCloseReminder(log = console) {
  const { rows: [{ open }] } = await pool.query(`select exists(select 1 from cash_sessions where closed_at is null) as open`);
  if (!open) return { sent: 0, reason: 'La caja ya está cerrada' };
  const k = await keys();
  webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:avisos@pancho-esquites.app', k.vapid_public, k.vapid_private);
  const { rows: subs } = await pool.query(`select endpoint, p256dh, auth from push_subscriptions`);
  const payload = JSON.stringify({ title: 'Pancho Esquites', body: 'Ya son las 9 pm: hay que cerrar la caja.', url: '/' });
  let sent = 0, removed = 0, failed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { await pool.query(`delete from push_subscriptions where endpoint = $1`, [s.endpoint]); removed++; }
      else { failed++; log.warn?.('Aviso no enviado:', e.statusCode ?? e.message); }
    }
  }
  return { sent, removed, failed };
}

// Reloj interno: todos los días a las 03:00 UTC (9 pm en Ciudad de México, sin horario de verano)
let lastDay = '';
export function startScheduler() {
  setInterval(async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== 3 || now.getUTCMinutes() !== 0 || lastDay === day) return;
    lastDay = day;
    try { console.log('Aviso de cierre:', await sendCloseReminder()); } catch (e) { console.error('Aviso de cierre falló:', e.message); }
  }, 20 * 1000).unref();
  // limpieza diaria: usuarios anónimos de más de 30 días que nunca se activaron
  setInterval(() => pool.query(`delete from auth.users u where u.created_at < now() - interval '30 days' and u.email is null
    and not exists (select 1 from devices d where d.user_id = u.id)`).catch(() => {}), 6 * 3600 * 1000).unref();
}
