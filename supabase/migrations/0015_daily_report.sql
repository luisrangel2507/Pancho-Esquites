-- Reporte del día por correo: al cerrar la caja se manda el resumen a hasta 3 correos que elige el dueño.
-- Lo envía la función "aviso-cierre" (acción "report") con Brevo. Se puede correr más de una vez.
create table if not exists report_settings (
  id int primary key default 1 check (id = 1),
  emails text[] not null default '{}'
);
alter table report_settings enable row level security;
insert into report_settings(id) values (1) on conflict do nothing;
revoke all on report_settings from anon, authenticated;

create or replace function report_settings_get(p_admin_pin text) returns text[]
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := staff_owner(p_admin_pin);
  return (select emails from report_settings where id = 1);
end $$;

-- p_fn_url: la app manda la dirección de su función para que el cierre sepa a dónde llamar
create or replace function report_settings_set(p_admin_pin text, p_emails text[], p_fn_url text default null) returns text[]
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; clean text[];
begin
  e := staff_owner(p_admin_pin);
  select coalesce(array_agg(distinct lower(trim(x))), '{}') into clean from unnest(coalesce(p_emails, '{}')) x where trim(x) <> '';
  if cardinality(clean) > 3 then raise exception 'Máximo 3 correos'; end if;
  if exists(select 1 from unnest(clean) x where x !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(x) > 120) then raise exception 'Correo no válido'; end if;
  update report_settings set emails = clean where id = 1;
  if p_fn_url ~ '^https://[a-z0-9-]+\.supabase\.co/functions/v1/aviso-cierre$' then
    update push_config set fn_url = coalesce(fn_url, p_fn_url) where id = 1;
  end if;
  return clean;
end $$;

-- Pide a la función que mande el reporte de una caja (solo si hay correos y la función ya está conectada)
create or replace function report_request(p_session bigint) returns void
language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := c.fn_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', c.cron_secret),
    body := jsonb_build_object('action', 'report', 'session_id', p_session))
  from push_config c
  where c.fn_url is not null and exists(select 1 from report_settings where id = 1 and cardinality(emails) > 0);
$$;

create or replace function report_send_test(p_admin_pin text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; sid bigint;
begin
  e := staff_owner(p_admin_pin);
  select max(id) into sid from cash_sessions;
  if sid is null then raise exception 'Todavía no hay cajas para reportar'; end if;
  if not exists(select 1 from report_settings where id = 1 and cardinality(emails) > 0) then raise exception 'Primero guarda un correo'; end if;
  if (select fn_url from push_config where id = 1) is null then raise exception 'Falta conectar la función aviso-cierre'; end if;
  perform report_request(sid);
  return true;
end $$;

create or replace function cash_close(p_pin text, p_counted_cents int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; sid bigint; s jsonb;
begin
  e := check_pin(p_pin);
  if p_counted_cents is null or p_counted_cents < 0 or p_counted_cents > 100000000 then raise exception 'Monto no válido'; end if;
  select id into sid from cash_sessions where closed_at is null for update;
  if sid is null then raise exception 'No hay caja abierta'; end if;
  s := cash_summary(sid);
  update cash_sessions set closed_at = now(), closed_by = e.id,
    expected_cents = (s->>'expected_cents')::int, counted_cents = p_counted_cents
  where id = sid;
  perform report_request(sid);
  return cash_summary(sid);
end $$;


grant execute on function cash_summary(bigint) to service_role;
revoke execute on function report_request(bigint) from anon, authenticated, public;
revoke execute on function report_settings_get(text), report_settings_set(text, text[], text), report_send_test(text) from anon, public;
grant execute on function report_settings_get(text), report_settings_set(text, text[], text), report_send_test(text) to authenticated;
