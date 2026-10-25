-- Notificaciones push: aviso de cierre de caja a las 9 pm (hora de Ciudad de México = 03:00 UTC, sin horario de verano)
-- aunque la app esté cerrada. Los teléfonos se registran con push_subscribe; la función de Supabase
-- "aviso-cierre" genera sus llaves la primera vez y manda los avisos. Se puede correr más de una vez.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create table if not exists push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  employee_id uuid references employees(id) on delete set null,
  device_id uuid,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;

-- Llaves y secreto los llena la función "aviso-cierre"; solo ella (service_role) y el cron los leen
create table if not exists push_config (
  id int primary key default 1 check (id = 1),
  vapid_public text,
  vapid_private text,
  fn_url text,
  cron_secret text not null default encode(extensions.gen_random_bytes(24), 'hex')
);
alter table push_config enable row level security;
insert into push_config(id) values (1) on conflict do nothing;
revoke all on push_subscriptions, push_config from anon, authenticated;

create or replace function push_subscribe(p_pin text, p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_pin);
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 or coalesce(length(p_p256dh), 0) not between 20 and 200
     or coalesce(length(p_auth), 0) not between 10 and 100 then
    raise exception 'Suscripción no válida';
  end if;
  insert into push_subscriptions(endpoint, p256dh, auth, employee_id, device_id)
  values (p_endpoint, p_p256dh, p_auth, e.id, auth.uid())
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
    employee_id = excluded.employee_id, device_id = excluded.device_id;
end $$;

revoke execute on function push_subscribe(text, text, text, text) from anon, public;
grant execute on function push_subscribe(text, text, text, text) to authenticated;

-- Todos los días a las 03:00 UTC (9 pm CDMX): si la caja sigue abierta, llama a la función que manda los avisos
select cron.unschedule(jobid) from cron.job where jobname = 'aviso-cierre';
select cron.schedule('aviso-cierre', '0 3 * * *', $cron$
  select net.http_post(
    url := c.fn_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', c.cron_secret),
    body := '{}'::jsonb)
  from public.push_config c
  where c.fn_url is not null and exists (select 1 from public.cash_sessions where closed_at is null)
$cron$);
