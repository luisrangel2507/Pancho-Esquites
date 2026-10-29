// Servidor estático para Railway (o cualquier hosting con Node): sirve la carpeta "out" que genera "next build"
// y aplica las mismas cabeceras de seguridad y de caché que public/_headers (que solo lee Cloudflare).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
};

// Reglas de out/_headers: bloques "ruta" + líneas con sangría "Nombre: valor"
const rules = [];
const hf = path.join(ROOT, '_headers');
if (existsSync(hf)) {
  let cur = null;
  for (const raw of readFileSync(hf, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    if (!/^\s/.test(raw)) {
      const re = new RegExp('^' + raw.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      cur = { re, h: {} }; rules.push(cur);
    } else if (cur) {
      const i = raw.indexOf(':');
      cur.h[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
    }
  }
}
const headersFor = p => Object.assign({}, ...rules.filter(r => r.re.test(p)).map(r => r.h));

async function pick(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const base = path.normalize(path.join(ROOT, clean));
  if (!base.startsWith(ROOT)) return null; // evita salirse de la carpeta
  for (const f of [base, base + '.html', path.join(base, 'index.html')]) {
    try { if ((await stat(f)).isFile()) return f; } catch { /* siguiente */ }
  }
  return null;
}

http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') { res.writeHead(200).end('ok'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const urlPath = new URL(req.url, 'http://x').pathname;
    let file = await pick(urlPath), status = 200;
    if (!file) { file = path.join(ROOT, '404.html'); status = 404; }
    const ext = path.extname(file);
    const h = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', ...headersFor(urlPath) };
    if (!h['Cache-Control']) h['Cache-Control'] = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    const body = await readFile(file).catch(() => Buffer.from('No encontrado'));
    res.writeHead(status, { ...h, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Error del servidor');
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Pancho Esquites en el puerto ${PORT}`));
