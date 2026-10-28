-- Imitación mínima de Supabase para probar las migraciones en un Postgres local.
do $$ begin if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$;
do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;
create schema extensions; create extension pgcrypto schema extensions;
grant usage on schema extensions to anon, authenticated;
create schema auth; grant usage on schema auth to anon, authenticated;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, encrypted_password text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;

-- Imitación de pg_cron y pg_net (no vienen en un Postgres local). run.sh quita los "create extension" de esas dos.
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as
  $$ insert into cron.job(jobname, schedule, command) values (n, s, c) on conflict (jobname) do update set schedule = s, command = c returning jobid $$;
create or replace function cron.unschedule(id bigint) returns boolean language sql as $$ delete from cron.job where jobid = id returning true $$;
create schema if not exists net;
create table if not exists net.calls (id bigserial, url text, headers jsonb, body jsonb);
create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}') returns bigint language sql as
  $$ insert into net.calls(url, headers, body) values (url, headers, body) returning id $$;
