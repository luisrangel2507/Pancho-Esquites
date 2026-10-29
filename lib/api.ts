// Cliente del servidor propio (reemplaza a Supabase). Cada teléfono guarda un token firmado por el servidor.
const KEY = 'pancho-token';
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (t: string | null) => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* sin almacenamiento */ } };

export const mx = (cents: number) =>
  (cents / 100).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

export type Product = { id: number; category_id: number; name: string; short_name: string | null; price_cents: number; photo_path: string | null };
export type Category = { id: number; name: string };
export type Employee = { employee_id: string; name: string; role: 'cajero' | 'admin' };

type Res<T> = { data: T | null; error: { message: string } | null };

async function signIn(): Promise<Res<{ session: { access_token: string } }>> {
  try {
    const r = await fetch('/api/auth/anonymous', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { data: null, error: { message: j.message || `Error ${r.status}` } };
    write(j.token);
    return { data: { session: { access_token: j.token } }, error: null };
  } catch { return { data: null, error: { message: 'Sin conexión' } }; }
}

// Llama al servidor con el token; si la sesión ya no vale, abre una nueva y reintenta una vez
async function call<T>(path: string, init: RequestInit, retry = true): Promise<Res<T>> {
  try {
    const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${read() ?? ''}` } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && retry) { write(null); const s = await signIn(); if (!s.error) return call<T>(path, init, false); }
    if (!r.ok) return { data: null, error: { message: j.message || `Error ${r.status}` } };
    return { data: (j.data ?? j) as T, error: null };
  } catch { return { data: null, error: { message: 'Sin conexión' } }; }
}

export const api = {
  auth: {
    async getSession() { const t = read(); return { data: { session: t ? { access_token: t } : null } }; },
    signInAnonymously: signIn,
  },
  rpc: <T = any>(fn: string, args?: Record<string, unknown>) => call<T>(`/api/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args ?? {}) }),
  menu: () => call<{ categories: Category[]; products: Product[] }>('/api/menu', { method: 'GET' }),
  photo: (path: string) => `/fotos/${path}`,
};

// Llama una función de la base; si el turno venció o se quitó el teléfono, avisa a la app
export async function rpc<T = any>(fn: string, args?: Record<string, unknown>) {
  const res = await api.rpc<T>(fn, args);
  if (res.error && /Turno vencido/.test(res.error.message)) window.dispatchEvent(new Event('turno-vencido'));
  if (res.error && /Dispositivo no autorizado/.test(res.error.message)) window.dispatchEvent(new Event('dispositivo-quitado'));
  return res;
}
