// Base de datos: arranque (migraciones), llamadas a funciones como "authenticated" y secretos.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = f => readFileSync(path.join(ROOT, f), 'utf8');

if (!process.env.DATABASE_URL) {
  console.error('Falta la variable DATABASE_URL (en Railway: agrega la base Postgres y enlázala al servicio).');
  process.exit(1);
}
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 15000 });
pool.on('error', e => console.error('Error de conexión a la base:', e.message));

// Crea o actualiza la base al arrancar. Con un candado para que dos arranques no choquen.
export async function migrate() {
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(7770001)');
    await c.query(sql('db/prelude.sql'));
    const fresh = (await c.query(`select to_regclass('public.sales') is null as fresh`)).rows[0].fresh;
    if (fresh) {
      console.log('Base nueva: creando tablas y menú…');
      await c.query(sql('supabase/migrations/0001_init.sql'));
      await c.query(sql('supabase/migrations/0002_seed.sql'));
    }
    await c.query(sql('db/updates.sql'));
    await c.query(sql('db/hardening.sql'));
    await c.query('select pg_advisory_unlock(7770001)');
  } finally { c.release(); }
}

// Primer arranque: crea al administrador con BOOTSTRAP_ADMIN_PIN y un código para activar el primer teléfono
export async function bootstrap() {
  const pin = process.env.BOOTSTRAP_ADMIN_PIN;
  const { rows: [{ n }] } = await pool.query(`select count(*)::int as n from employees where role = 'admin' and active and not is_support`);
  if (n === 0) {
    if (/^\d{6}$/.test(pin ?? '')) {
      await pool.query(`insert into employees(name, pin_hash, role) values ('Dueño', extensions.crypt($1, extensions.gen_salt('bf', 8)), 'admin')`, [pin]);
      console.log('Administrador "Dueño" creado con el PIN de BOOTSTRAP_ADMIN_PIN. Ya puedes borrar esa variable.');
    } else {
      console.warn('No hay administrador. Agrega la variable BOOTSTRAP_ADMIN_PIN (6 números) y reinicia.');
    }
  }
  const { rows: [{ d }] } = await pool.query(`select count(*)::int as d from devices`);
  if (d === 0) {
    const { rows: [{ code }] } = await pool.query(`select device_code_bootstrap('Caja 1') as code`);
    console.log(`\n=================================================\n  CÓDIGO PARA ACTIVAR EL PRIMER TELÉFONO: ${code}\n  (sirve una vez y dura 30 minutos; reinicia para otro)\n=================================================\n`);
  }
}

// Secreto para firmar sesiones: de SESSION_SECRET o, si no hay, uno que se guarda en la base
export async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  await pool.query(`insert into server_config(key, value) values ('session_secret', $1) on conflict do nothing`, [randomBytes(32).toString('hex')]);
  return (await pool.query(`select value from server_config where key = 'session_secret'`)).rows[0].value;
}

// ───── Llamadas a funciones de la base ─────
let fns = new Map();
export async function loadFunctions() {
  const { rows } = await pool.query(`
    select p.proname as name, p.proretset as retset,
           (p.proargnames)[1:p.pronargs] as names,
           array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) as types
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'`);
  fns = new Map(rows.map(r => [r.name, r]));
}

export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Corre dentro de una transacción como el rol "authenticated" con auth.uid() = uid.
// La base decide qué se puede llamar: lo que no tenga permiso da "permission denied".
export async function withUser(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`insert into auth.users(id) values ($1) on conflict do nothing`, [uid]);
    await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}

export async function callRpc(uid, name, args) {
  const f = fns.get(name);
  if (!f || !/^[a-z_][a-z0-9_]*$/.test(name)) throw new ApiError(404, `Could not find the function public.${name} in the schema cache`);
  const given = Object.keys(args ?? {});
  for (const k of given) if (!(f.names ?? []).includes(k)) throw new ApiError(400, `Argumento desconocido: ${k}`);
  const vals = [], parts = [];
  (f.names ?? []).forEach((n, i) => {
    if (!(n in args)) return;
    let v = args[n]; const t = f.types[i];
    if (v !== null && v !== undefined && (t === 'jsonb' || t === 'json')) v = JSON.stringify(v);
    vals.push(v === undefined ? null : v);
    parts.push(`${n} => $${vals.length}::${t}`);
  });
  const call = `public.${name}(${parts.join(', ')})`;
  return withUser(uid, async c => {
    if (f.retset) return (await c.query(`select * from ${call}`, vals)).rows;
    return (await c.query(`select ${call} as r`, vals)).rows[0].r;
  });
}

export async function menu(uid) {
  return withUser(uid, async c => ({
    categories: (await c.query('select id, name from categories order by sort, id')).rows,
    products: (await c.query('select * from products where active order by sort, id')).rows,
  }));
}
