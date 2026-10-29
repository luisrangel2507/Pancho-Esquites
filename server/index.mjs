// Servidor de Pancho Esquites: sirve la app (carpeta "out") y la API que usa (reemplaza a Supabase).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { pool, migrate, bootstrap, sessionSecret, loadFunctions, callRpc, menu, ApiError } from './db.mjs';
import { publicKey, startScheduler } from './push.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
};

// Cabeceras de seguridad y caché: mismas reglas de out/_headers
const rules = [];
if (existsSync(path.join(ROOT, '_headers'))) {
  let cur = null;
  for (const raw of readFileSync(path.join(ROOT, '_headers'), 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    if (!/^\s/.test(raw)) {
      cur = { re: new RegExp('^' + raw.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), h: {} };
      rules.push(cur);
    } else if (cur) {
      const i = raw.indexOf(':'); cur.h[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
    }
  }
}
const headersFor = p => Object.assign({}, ...rules.filter(r => r.re.test(p)).map(r => r.h));

// ───── Sesión de cada teléfono: token firmado con la identidad anónima ─────
let SECRET = '';
const sign = uid => `${uid}.${createHmac('sha256', SECRET).update(uid).digest('base64url')}`;
function verify(token) {
  const [uid, mac] = String(token ?? '').split('.');
  if (!/^[0-9a-f-]{36}$/.test(uid ?? '') || !mac) return null;
  const good = createHmac('sha256', SECRET).update(uid).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(good);
  return a.length === b.length && timingSafeEqual(a, b) ? uid : null;
}

// Límite de sesiones nuevas por dirección (evita llenar la base)
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), list = (hits.get(ip) ?? []).filter(t => now - t < 3600e3);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k);
  return list.length > 30;
}
const clientIp = req => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

async function body(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 100_000) throw new ApiError(413, 'Solicitud demasiado grande'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'JSON no válido'); }
}
const send = (res, status, obj) => {
  const b = JSON.stringify(obj);
  // con 413 el cliente sigue mandando datos: se cierra la conexión para que no quede a medias
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(status === 413 ? { Connection: 'close' } : {}), ...headersFor('/api') });
  res.end(b);
};

async function api(req, res, p) {
  if (p === '/api/auth/anonymous' && req.method === 'POST') {
    if (tooMany(clientIp(req))) throw new ApiError(429, 'Demasiados intentos, espera un rato');
    const { rows: [{ id }] } = await pool.query('insert into auth.users(id) values ($1) returning id', [randomUUID()]);
    return send(res, 200, { token: sign(id) });
  }
  if (p === '/api/push-key' && req.method === 'GET') return send(res, 200, { publicKey: await publicKey() });

  const uid = verify((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  if (!uid) throw new ApiError(401, 'Sesión no válida');
  if (p === '/api/menu' && req.method === 'GET') return send(res, 200, await menu(uid));
  const m = p.match(/^\/api\/rpc\/([a-z_][a-z0-9_]*)$/);
  if (m && req.method === 'POST') return send(res, 200, { data: await callRpc(uid, m[1], await body(req)) });
  throw new ApiError(404, 'No encontrado');
}

async function pick(urlPath) {
  const clean = decodeURIComponent(urlPath);
  const base = path.normalize(path.join(ROOT, clean));
  if (!base.startsWith(ROOT)) return null; // evita salirse de la carpeta
  for (const f of [base, base + '.html', path.join(base, 'index.html')]) {
    try { if ((await stat(f)).isFile()) return f; } catch { /* siguiente */ }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/healthz') {
      await pool.query('select 1');
      res.writeHead(200).end('ok'); return;
    }
    if (p.startsWith('/api/')) return await api(req, res, p);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    let file = await pick(p), status = 200;
    if (!file) { file = path.join(ROOT, '404.html'); status = 404; }
    const ext = path.extname(file);
    const h = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', ...headersFor(p) };
    if (!h['Cache-Control']) h['Cache-Control'] = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    const data = await readFile(file).catch(() => Buffer.from('No encontrado'));
    res.writeHead(status, { ...h, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof ApiError) return send(res, e.status, { message: e.message });
    // error de la base (por ejemplo raise exception de una función): su texto es el mensaje para la app
    if (e?.code && typeof e.message === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return send(res, 400, { message: e.message });
    console.error('Error:', e);
    send(res, 500, { message: 'Error del servidor' });
  }
});

process.on('unhandledRejection', e => console.error('Rechazo no manejado:', e));

(async () => {
  await migrate();
  SECRET = await sessionSecret();
  await loadFunctions();
  await bootstrap();
  startScheduler();
  server.listen(PORT, '0.0.0.0', () => console.log(`Pancho Esquites en el puerto ${PORT}`));
})().catch(e => { console.error('No se pudo arrancar:', e); process.exit(1); });

// Apagado limpio (Railway manda SIGTERM al reiniciar): deja de aceptar conexiones y sale; tope de 5 s
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => {
  setTimeout(() => process.exit(0), 5000).unref();
  server.close(() => pool.end().finally(() => process.exit(0)));
  server.closeAllConnections?.();
});
