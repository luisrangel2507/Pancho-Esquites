// Función de Supabase "aviso-cierre": manda el aviso de cierre de caja por notificación push.
// - GET: devuelve la llave pública para que los teléfonos se registren (la crea la primera vez).
// - POST: la llama el cron de las 9 pm con el secreto de push_config; si la caja sigue abierta, avisa a todos.
// - POST {action:"report", session_id}: la llama el cierre de caja; manda el reporte del día por correo (Brevo).
//   Secretos de la función: BREVO_API_KEY y REPORT_FROM (correo remitente verificado en Brevo).
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
    const body = await req.json().catch(() => ({}));
    if (body.action === 'report') return json(await sendReport(Number(body.session_id)));

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

// ───── Reporte del día por correo ─────
const mx = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('es-MX');
const esc = (t: string) => t.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const when = (iso: string) => new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

async function sendReport(sessionId: number) {
  const key = Deno.env.get('BREVO_API_KEY'), from = Deno.env.get('REPORT_FROM');
  if (!key || !from) return { sent: 0, error: 'Faltan los secretos BREVO_API_KEY o REPORT_FROM' };
  if (!Number.isFinite(sessionId)) return { sent: 0, error: 'Caja no válida' };

  const { data: cfg } = await db.from('report_settings').select('emails').eq('id', 1).single();
  const to: string[] = cfg?.emails ?? [];
  if (!to.length) return { sent: 0, reason: 'Sin correos' };

  const { data: s, error } = await db.rpc('cash_summary', { p_id: sessionId });
  if (error || !s) throw new Error('cash_summary: ' + (error?.message ?? 'sin datos'));
  const { data: items } = await db.from('sale_items')
    .select('qty, unit_price_cents, products(name), sales!inner(session_id, voided)')
    .eq('sales.session_id', sessionId).eq('sales.voided', false);

  const top = new Map<string, { qty: number; cents: number }>();
  type Item = { qty: number; unit_price_cents: number; products: { name: string } | { name: string }[] | null };
  for (const it of (items ?? []) as unknown as Item[]) {
    const p = Array.isArray(it.products) ? it.products[0] : it.products;
    const n = p?.name ?? 'Producto';
    const t = top.get(n) ?? { qty: 0, cents: 0 };
    t.qty += it.qty; t.cents += it.qty * it.unit_price_cents; top.set(n, t);
  }
  const best = [...top.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 5);
  const avg = s.tickets ? Math.round(s.total_cents / s.tickets) : 0;
  const closed = s.counted_cents !== null && s.counted_cents !== undefined;
  const diff = closed ? s.counted_cents - s.expected_cents : 0;
  const diffTxt = !closed ? 'Caja abierta' : diff === 0 ? 'Cuadra ✓' : (diff > 0 ? 'Sobra ' : 'Falta ') + mx(Math.abs(diff));
  const row = (l: string, v: string, b = false) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eadbb4">${l}</td><td style="padding:8px 0;border-bottom:1px solid #eadbb4;text-align:right${b ? ';font-weight:700' : ''}">${v}</td></tr>`;

  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#2a1c13">
  <div style="background:#0b4a2a;color:#fff;padding:18px;border-radius:14px 14px 0 0">
    <div style="font-size:14px;opacity:.85">Reporte del día · Pancho Esquites</div>
    <div style="font-size:30px;font-weight:700;color:#f7cc3e">${mx(s.total_cents)}</div>
    <div style="font-size:14px">${s.tickets} tickets · promedio ${mx(avg)}</div>
  </div>
  <div style="background:#fcf1d8;padding:16px 18px;border-radius:0 0 14px 14px">
    <p style="margin:0 0 10px;font-size:13px;color:#7a6450">Abrió ${esc(s.opened_by)} el ${when(s.opened_at)}${s.closed_at ? ` · cerró ${esc(s.closed_by ?? '')} el ${when(s.closed_at)}` : ''}</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      ${row('Fondo inicial', mx(s.opening_cents))}
      ${row('+ Efectivo recibido', mx(s.cash_received_cents ?? s.cash_cents))}
      ${row('− Cambio entregado', mx(s.change_cents ?? 0))}
      ${row('Efectivo esperado', mx(s.expected_cents), true)}
      ${closed ? row('Efectivo contado', mx(s.counted_cents)) : ''}
      ${row('Diferencia', diffTxt, true)}
      ${row('Tarjeta', mx(s.card_cents))}
      ${row('Transferencia', mx(s.spei_cents))}
      ${s.voided ? row(`Anuladas (${s.voided})`, mx(s.voided_cents)) : ''}
    </table>
    ${best.length ? `<h3 style="margin:16px 0 6px;font-size:16px">Más vendidos</h3><table style="width:100%;border-collapse:collapse;font-size:15px">
      ${best.map(([n, v], i) => row(`${i + 1}. ${esc(n)}`, `${v.qty} pzas · ${mx(v.cents)}`)).join('')}</table>` : ''}
  </div></div>`;

  const day = new Date(s.opened_at).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short' });
  const r = await fetch(Deno.env.get('BREVO_URL') ?? 'https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Pancho Esquites', email: from },
      to: to.map(email => ({ email })),
      subject: `Reporte ${day}: ${mx(s.total_cents)} · ${diffTxt}`,
      htmlContent: html,
    }),
  });
  if (!r.ok) return { sent: 0, error: `Brevo ${r.status}: ${(await r.text()).slice(0, 200)}` };
  return { sent: to.length };
}
