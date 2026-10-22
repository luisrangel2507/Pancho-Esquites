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
