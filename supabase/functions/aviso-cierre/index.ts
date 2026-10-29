// Función de Supabase "aviso-cierre": manda el aviso de cierre de caja por notificación push.
// - GET: devuelve la llave pública para que los teléfonos se registren (la crea la primera vez).
// - POST: la llama el cron de las 9 pm con el secreto de push_config; si la caja sigue abierta, avisa a todos.
// Desplegar con "Enforce JWT verification" APAGADO: el cron no manda sesión; el POST se protege con el secreto.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

type Config = { vapid_public: string | null; vapid_private: string | null; fn_url: string | null; cron_secret: string };

async function config(): Promise<Config> {
  const read = async () => {
    const { data, error } = await db.from('push_config').select('*').eq('id', 1).single();
    if (error) throw new Error('push_config: ' + error.message);
    return data as Config;
  };
  let c = await read();
  if (!c.vapid_public || !c.vapid_private) {
    const k = webpush.generateVAPIDKeys();
    // solo la primera llamada guarda llaves; si dos llegan a la vez, gana una y la otra relee
    await db.from('push_config').update({ vapid_public: k.publicKey, vapid_private: k.privateKey }).eq('id', 1).is('vapid_public', null);
    c = await read();
  }
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/aviso-cierre`;
  if (c.fn_url !== url) await db.from('push_config').update({ fn_url: url }).eq('id', 1);
  return c;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const c = await config();
    if (req.method === 'GET') return json({ publicKey: c.vapid_public });
    if (req.method !== 'POST' || req.headers.get('x-cron-secret') !== c.cron_secret) return json({ error: 'No autorizado' }, 401);

    const { count, error } = await db.from('cash_sessions').select('id', { count: 'exact', head: true }).is('closed_at', null);
    if (error) throw new Error('cash_sessions: ' + error.message);
    if (!count) return json({ sent: 0, reason: 'La caja ya está cerrada' });

    webpush.setVapidDetails('mailto:avisos@pancho-esquites.app', c.vapid_public!, c.vapid_private!);
    const { data: subs } = await db.from('push_subscriptions').select('endpoint, p256dh, auth');
    const payload = JSON.stringify({ title: 'Pancho Esquites', body: 'Ya son las 9 pm: hay que cerrar la caja.', url: '/' });
    let sent = 0, removed = 0, failed = 0;
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // 404/410: el teléfono ya no existe o quitó el permiso
        if (code === 404 || code === 410) { await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint); removed++; }
        else failed++;
      }
    }
    return json({ sent, removed, failed });
  } catch (e) {
    return json({ error: (e as Error).message ?? String(e) }, 500);
  }
});
