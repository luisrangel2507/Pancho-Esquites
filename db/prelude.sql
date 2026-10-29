-- Entorno mínimo para correr el esquema en una Postgres normal (Railway): roles, esquema "auth" y pgcrypto.
-- Se ejecuta en cada arranque del servidor; es seguro repetirlo.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
grant usage on schema extensions to anon, authenticated;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated;
-- Cada teléfono es un usuario anónimo; el servidor firma su token y fija auth.uid() en cada llamada
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;

grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;

-- Secretos del servidor (firma de sesiones); nadie desde la app puede leerlos
create table if not exists public.server_config (key text primary key, value text not null);
revoke all on public.server_config from anon, authenticated;
