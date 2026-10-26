import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: true, autoRefreshToken: true } }
);

export const mx = (cents: number) =>
  (cents / 100).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

export type Product = { id: number; category_id: number; name: string; short_name: string | null; price_cents: number; photo_path: string | null };
export type Category = { id: number; name: string };
export type Employee = { employee_id: string; name: string; role: 'cajero' | 'admin' };

// Llama una función de la base; si el turno venció avisa a la app para pedir el PIN otra vez
export async function rpc(fn: string, args?: Record<string, unknown>) {
  const res = await supabase.rpc(fn, args);
  if (res.error && /Turno vencido/.test(res.error.message)) window.dispatchEvent(new Event('turno-vencido'));
  if (res.error && /Dispositivo no autorizado/.test(res.error.message)) window.dispatchEvent(new Event('dispositivo-quitado'));
  return res;
}
