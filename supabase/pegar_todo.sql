set check_function_bodies = off;

drop function if exists staff_list(text);

create or replace function sales_report(p_admin_pin text, p_from timestamptz, p_to timestamptz, p_tz text default 'America/Mexico_City')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare e employees; span interval; r jsonb;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede ver ventas'; end if;
  span := p_to - p_from;

  with s as (select * from sales where created_at >= p_from and created_at < p_to),
  ok as (select * from s where not voided),
  prev as (select total_cents from sales where not voided and created_at >= p_from - span and created_at < p_from),
  it as (
    select si.qty, si.unit_price_cents, p.name, coalesce(c.name, 'Otros') as cat
    from sale_items si join ok on ok.id = si.sale_id join products p on p.id = si.product_id left join categories c on c.id = p.category_id
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'cents', coalesce((select sum(total_cents) from ok), 0),
      'tickets', (select count(*) from ok),
      'items', coalesce((select sum(qty) from it), 0),
      'voided', (select count(*) from s where voided),
      'voided_cents', coalesce((select sum(total_cents) from s where voided), 0)),
    'prev', jsonb_build_object('cents', coalesce((select sum(total_cents) from prev), 0), 'tickets', (select count(*) from prev)),
    'by_pay', coalesce((select jsonb_agg(x order by x.cents desc) from (
      select pay_method as method, sum(total_cents) as cents, count(*) as tickets from ok group by 1) x), '[]'),
    'top', coalesce((select jsonb_agg(x order by x.qty desc, x.cents desc) from (
      select name, sum(qty) as qty, sum(qty * unit_price_cents) as cents from it group by name
      order by sum(qty) desc, sum(qty * unit_price_cents) desc limit 10) x), '[]'),
    'by_cat', coalesce((select jsonb_agg(x order by x.cents desc) from (
      select cat as name, sum(qty) as qty, sum(qty * unit_price_cents) as cents from it group by cat) x), '[]'),
    'by_hour', coalesce((select jsonb_agg(x order by x.hour) from (
      select extract(hour from created_at at time zone p_tz)::int as hour, sum(total_cents) as cents, count(*) as tickets from ok group by 1) x), '[]'),
    'by_day', coalesce((select jsonb_agg(x order by x.day) from (
      select to_char((created_at at time zone p_tz)::date, 'YYYY-MM-DD') as day, sum(total_cents) as cents, count(*) as tickets from ok group by 1) x), '[]'),
    'by_emp', coalesce((select jsonb_agg(x order by x.cents desc) from (
      select em.name, sum(ok.total_cents) as cents, count(*) as tickets from ok join employees em on em.id = ok.employee_id group by em.name) x), '[]'),
    'recent', coalesce((select jsonb_agg(x order by x.id desc) from (
      select s.id, s.created_at as at, em.name as employee, s.total_cents, s.pay_method, s.voided
      from s join employees em on em.id = s.employee_id order by s.id desc limit 30) x), '[]')
  ) into r;
  return r;
end $$;

create table if not exists cash_sessions (
  id bigserial primary key,
  opened_by uuid not null references employees(id),
  opened_at timestamptz not null default now(),
  opening_cents int not null check (opening_cents >= 0),
  closed_by uuid references employees(id),
  closed_at timestamptz,
  expected_cents int,
  counted_cents int check (counted_cents >= 0)
);

create unique index if not exists one_open_cash_session on cash_sessions ((true)) where closed_at is null;

alter table cash_sessions enable row level security;

drop policy if exists cash_admin on cash_sessions;

create policy cash_admin on cash_sessions for select using (is_admin());

alter table sales add column if not exists session_id bigint references cash_sessions(id);

create index if not exists sales_session_id_idx on sales(session_id);

create or replace function cash_history(p_admin_pin text, p_limit int default 20) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede ver los cierres'; end if;
  return coalesce((select jsonb_agg(cash_summary(t.id) order by t.id desc)
    from (select id from cash_sessions order by id desc limit least(coalesce(p_limit, 20), 60)) t), '[]'::jsonb);
end $$;

create table if not exists shifts (
  token_hash text primary key,
  employee_id uuid not null references employees(id) on delete cascade,
  device_id uuid not null,
  started_at timestamptz not null default now(),
  last_used timestamptz not null default now()
);

alter table shifts enable row level security;

drop function if exists shift_start(text);

create or replace function pin_login(p_pin text)
returns table(employee_id uuid, name text, role text)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := pin_verify(p_pin);
  if e.id is null then return; end if;
  return query select e.id, e.name, e.role;
end $$;

create or replace function shift_end(p_token text) returns void
language sql security definer set search_path = public, extensions as $$
  delete from shifts where token_hash = encode(digest(substr(p_token, 3), 'sha256'), 'hex') and device_id = auth.uid();
$$;

create or replace function cash_status(p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_pin);
  return cash_state();
end $$;

create or replace function cash_open(p_pin text, p_opening_cents int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; sid bigint;
begin
  e := check_pin(p_pin);
  if e.role <> 'admin' then raise exception 'Solo un administrador puede abrir la caja'; end if;
  if p_opening_cents is null or p_opening_cents < 0 or p_opening_cents > 100000000 then raise exception 'Monto no válido'; end if;
  perform pg_advisory_xact_lock(hashtext('cash_open'));
  if exists(select 1 from cash_sessions where closed_at is null) then raise exception 'Ya hay una caja abierta'; end if;
  if (cash_state()->>'today_closed')::boolean then raise exception 'La caja de hoy ya se abrió y se cerró'; end if;
  insert into cash_sessions(opened_by, opening_cents) values (e.id, p_opening_cents) returning id into sid;
  return cash_summary(sid);
end $$;

drop function if exists shift_start(text);

create function shift_start(p_pin text)
returns table(employee_id uuid, name text, role text, token text, cash jsonb)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; tk text;
begin
  if p_pin like 'T:%' then raise exception 'PIN incorrecto'; end if;
  e := pin_verify(p_pin);
  if e.id is null then return; end if;
  tk := encode(gen_random_bytes(24), 'hex');
  delete from shifts where last_used < now() - interval '1 day';
  insert into shifts(token_hash, employee_id, device_id) values (encode(digest(tk, 'sha256'), 'hex'), e.id, auth.uid());
  return query select e.id, e.name, e.role, 'T:' || tk, cash_state();
end $$;

alter table employees add column if not exists is_support boolean not null default false;

alter table employees add column if not exists expires_at timestamptz;

create or replace function pin_verify(p_pin text) returns employees
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; fails int;
begin
  if not is_device() then raise exception 'Dispositivo no autorizado'; end if;
  select count(*) into fails from pin_attempts
    where device_id = auth.uid() and at > now() - interval '5 minutes';
  if fails >= 5 then raise exception 'Demasiados intentos. Espera 5 minutos.'; end if;
  select * into e from employees
    where active and (expires_at is null or expires_at > now()) and pin_hash = crypt(p_pin, pin_hash) limit 1;
  if e.id is null then
    insert into pin_attempts(device_id) values (auth.uid());
    return null;
  end if;
  delete from pin_attempts where device_id = auth.uid();
  if e.pin_hash not like '$2a$08$%' then
    update employees set pin_hash = crypt(p_pin, gen_salt('bf', 8)) where id = e.id;
  end if;
  return e;
end $$;

create or replace function check_pin(p_pin text) returns employees
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; t shifts;
begin
  if not is_device() then raise exception 'Dispositivo no autorizado'; end if;
  if p_pin like 'T:%' then
    update shifts set last_used = now()
      where token_hash = encode(digest(substr(p_pin, 3), 'sha256'), 'hex')
        and device_id = auth.uid() and last_used > now() - interval '3 hours'
      returning * into t;
    if t.employee_id is not null then
      select * into e from employees where id = t.employee_id and active and (expires_at is null or expires_at > now());
    end if;
    if e.id is null then raise exception 'Turno vencido, ingresa tu PIN'; end if;
    return e;
  end if;
  e := pin_verify(p_pin);
  if e.id is null then raise exception 'PIN incorrecto'; end if;
  return e;
end $$;

create or replace function staff_owner(p_admin_pin text) returns employees
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede administrar empleados'; end if;
  if e.is_support then raise exception 'El PIN de soporte no puede administrar empleados'; end if;
  return e;
end $$;

drop function if exists staff_list(text);

create function staff_list(p_admin_pin text)
returns table(id uuid, name text, role text, active boolean, is_support boolean, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede ver empleados'; end if;
  return query select x.id, x.name, x.role, x.active, x.is_support, x.expires_at from employees x
    order by x.is_support, x.active desc, x.name;
end $$;

create or replace function staff_upsert(p_admin_pin text, p_id uuid, p_name text, p_pin text, p_role text, p_active boolean)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare e employees; new_id uuid;
begin
  e := staff_owner(p_admin_pin);
  if p_role not in ('cajero', 'admin') then raise exception 'Rol no válido'; end if;
  if p_id is null and p_pin is null then raise exception 'Falta el PIN'; end if;
  if p_pin is not null and p_pin !~ '^\d{4,6}$' then raise exception 'PIN de 4 a 6 números'; end if;
  if exists(select 1 from employees where id = p_id and is_support) then raise exception 'El PIN de soporte se maneja aparte'; end if;
  if p_pin is not null and exists(select 1 from employees where active and pin_hash = crypt(p_pin, pin_hash) and id is distinct from p_id) then
    raise exception 'Ese PIN ya lo usa otro empleado';
  end if;
  if p_id = e.id and (not p_active or p_role <> 'admin') then raise exception 'No puedes quitarte tu propio acceso'; end if;
  if p_role = 'admin' and p_active and (select count(*) from employees where role = 'admin' and active and not is_support and id is distinct from p_id) >= 2 then
    raise exception 'Solo puede haber 2 administradores activos';
  end if;
  if p_id is null then
    insert into employees(name, pin_hash, role) values (trim(p_name), crypt(p_pin, gen_salt('bf', 8)), p_role) returning employees.id into new_id;
    return new_id;
  end if;
  update employees set name = trim(p_name), role = p_role, active = p_active,
    pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf', 8)) end
  where employees.id = p_id;
  return p_id;
end $$;

create or replace function staff_make_admin(p_admin_pin text, p_to uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := staff_owner(p_admin_pin);
  if not exists(select 1 from employees where id = p_to and active and not is_support) then raise exception 'Empleado no válido o inactivo'; end if;
  if (select count(*) from employees where role = 'admin' and active and not is_support and id <> p_to) >= 2 then
    raise exception 'Solo puede haber 2 administradores activos';
  end if;
  update employees set role = 'admin' where id = p_to;
end $$;

create or replace function staff_delete(p_admin_pin text, p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := staff_owner(p_admin_pin);
  if p_id = e.id then raise exception 'No puedes borrarte a ti mismo'; end if;
  if exists(select 1 from sales where employee_id = p_id or voided_by = p_id) then
    raise exception 'Ya tiene ventas registradas; solo puedes desactivarlo';
  end if;
  delete from employees where id = p_id;
end $$;

create or replace function support_pin_create(p_admin_pin text, p_hours int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; pin text; tries int := 0; until timestamptz;
begin
  e := staff_owner(p_admin_pin);
  if p_hours not in (24, 72, 168) then raise exception 'Duración no válida'; end if;
  update employees set active = false where is_support and active;
  loop
    tries := tries + 1;
    pin := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
    exit when not exists(select 1 from employees where active and pin_hash = crypt(pin, pin_hash));
    if tries >= 20 then raise exception 'No se pudo generar el PIN, intenta otra vez'; end if;
  end loop;
  until := now() + make_interval(hours => p_hours);
  insert into employees(name, pin_hash, role, is_support, expires_at)
    values ('Soporte', crypt(pin, gen_salt('bf', 8)), 'admin', true, until);
  return jsonb_build_object('pin', pin, 'expires_at', until);
end $$;

create or replace function support_pin_revoke(p_admin_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := staff_owner(p_admin_pin);
  update employees set active = false where is_support and active;
  delete from shifts where employee_id in (select id from employees where is_support);
end $$;

create or replace function biz_day(t timestamptz) returns date
language sql stable as $$ select ((t at time zone 'America/Mexico_City') - interval '5 hours')::date $$;

create or replace function cash_state() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select cash_summary(id) || jsonb_build_object('stale', biz_day(opened_at) < biz_day(now()))
       from cash_sessions where closed_at is null),
    jsonb_build_object('open', false, 'today_closed', exists(
      select 1 from cash_sessions where biz_day(opened_at) = biz_day(now()))))
$$;

create or replace function register_sale(p_pin text, p_items jsonb, p_pay text, p_cash_cents int default null)
returns table(sale_id bigint, total_cents int)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; s_id bigint; tot int := 0; it jsonb; pr products; cs bigint;
begin
  e := check_pin(p_pin);
  if jsonb_array_length(p_items) = 0 then raise exception 'Orden vacía'; end if;
  select id into cs from cash_sessions where closed_at is null;
  if cs is null then raise exception 'Abre la caja primero'; end if;
  if exists(select 1 from cash_sessions where id = cs and biz_day(opened_at) < biz_day(now())) then
    raise exception 'Cierra la caja de ayer primero';
  end if;

  insert into sales(employee_id, device_id, total_cents, pay_method, cash_received_cents, session_id)
  values (e.id, auth.uid(), 0, p_pay, p_cash_cents, cs) returning id into s_id;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into pr from products where id = (it->>'product_id')::int and active;
    if pr.id is null then raise exception 'Producto no válido'; end if;
    if (it->>'qty')::int not between 1 and 99 then raise exception 'Cantidad no válida'; end if;
    insert into sale_items(sale_id, product_id, qty, unit_price_cents, note)
    values (s_id, pr.id, (it->>'qty')::int, pr.price_cents, left(it->>'note', 120));
    tot := tot + pr.price_cents * (it->>'qty')::int;

    insert into inventory_moves(item_id, delta, reason, sale_id, by_user)
    select r.item_id, -r.qty * (it->>'qty')::int, 'venta', s_id, e.id
    from recipes r where r.product_id = pr.id;
    update inventory_items i set stock = greatest(0, i.stock - r.qty * (it->>'qty')::int)
    from recipes r where r.product_id = pr.id and r.item_id = i.id;
  end loop;

  if p_pay = 'cash' and coalesce(p_cash_cents, 0) < tot then
    raise exception 'El efectivo recibido no cubre el total';
  end if;
  update sales set total_cents = tot where id = s_id;
  return query select s_id, tot;
end $$;

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

select cron.unschedule(jobid) from cron.job where jobname = 'aviso-cierre';

select cron.schedule('aviso-cierre', '0 3 * * *', $cron$
  select net.http_post(
    url := c.fn_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', c.cron_secret),
    body := '{}'::jsonb)
  from public.push_config c
  where c.fn_url is not null and exists (select 1 from public.cash_sessions where closed_at is null)
$cron$);

create or replace function cash_summary(p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', c.id, 'open', c.closed_at is null,
    'opened_at', c.opened_at, 'opened_by', o.name,
    'closed_at', c.closed_at, 'closed_by', cl.name,
    'opening_cents', c.opening_cents,
    'tickets', coalesce(x.tickets, 0), 'total_cents', coalesce(x.total, 0),
    'cash_cents', coalesce(x.cash, 0), 'card_cents', coalesce(x.card, 0), 'spei_cents', coalesce(x.spei, 0),
    'voided', coalesce(x.voided, 0), 'voided_cents', coalesce(x.voided_cents, 0),
    'expected_cents', coalesce(c.expected_cents, c.opening_cents + coalesce(x.cash, 0)),
    'counted_cents', c.counted_cents,
    'cash_received_cents', coalesce(x.received, 0),
    'change_cents', coalesce(x.received, 0) - coalesce(x.cash, 0))
  from cash_sessions c
  join employees o on o.id = c.opened_by
  left join employees cl on cl.id = c.closed_by
  left join lateral (
    select count(*) filter (where not s.voided) as tickets,
      sum(s.total_cents) filter (where not s.voided) as total,
      sum(s.total_cents) filter (where not s.voided and s.pay_method = 'cash') as cash,
      sum(s.total_cents) filter (where not s.voided and s.pay_method = 'card') as card,
      sum(s.total_cents) filter (where not s.voided and s.pay_method = 'spei') as spei,
      sum(coalesce(s.cash_received_cents, s.total_cents)) filter (where not s.voided and s.pay_method = 'cash') as received,
      count(*) filter (where s.voided) as voided,
      sum(s.total_cents) filter (where s.voided) as voided_cents
    from sales s where s.session_id = c.id) x on true
  where c.id = p_id
$$;

alter table devices add column if not exists created_at timestamptz not null default now();

alter table sales drop constraint if exists sales_device_id_fkey;

create table if not exists device_codes (
  code_hash text primary key,
  label text not null,
  created_by uuid references employees(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid
);

alter table device_codes enable row level security;

create table if not exists device_code_attempts (at timestamptz not null default now(), uid uuid);

create index if not exists device_code_attempts_at on device_code_attempts(at);

alter table device_code_attempts enable row level security;

revoke all on device_codes, device_code_attempts from anon, authenticated;

create or replace function new_device_code(p_label text, p_by uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare abc text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789X'; raw bytea := gen_random_bytes(8); c text := ''; until timestamptz;
begin
  for i in 0..7 loop c := c || substr(abc, (get_byte(raw, i) % 32) + 1, 1); end loop;
  until := now() + interval '30 minutes';
  delete from device_codes where expires_at < now() - interval '1 day';
  insert into device_codes(code_hash, label, created_by, expires_at)
    values (encode(digest(c, 'sha256'), 'hex'), coalesce(nullif(trim(p_label), ''), 'Caja'), p_by, until);
  return jsonb_build_object('code', substr(c, 1, 4) || '-' || substr(c, 5, 4), 'expires_at', until);
end $$;

create or replace function device_code_create(p_admin_pin text, p_label text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := staff_owner(p_admin_pin);
  return new_device_code(p_label, e.id);
end $$;

create or replace function device_code_bootstrap(p_label text default 'Caja') returns text
language sql security definer set search_path = public, extensions as $$
  select new_device_code(p_label, null)->>'code';
$$;

create or replace function device_activate(p_code text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); row device_codes;
begin
  if auth.uid() is null then raise exception 'Sin sesión'; end if;
  if exists(select 1 from devices where user_id = auth.uid()) then return true; end if;
  if (select count(*) from device_code_attempts where at > now() - interval '15 minutes') >= 20 then
    raise exception 'Demasiados intentos. Espera 15 minutos.';
  end if;
  select * into row from device_codes
    where code_hash = encode(digest(c, 'sha256'), 'hex') and used_at is null and expires_at > now()
    for update;
  if row.code_hash is null then
    insert into device_code_attempts(uid) values (auth.uid());
    return false;
  end if;
  update device_codes set used_at = now(), used_by = auth.uid() where code_hash = row.code_hash;
  insert into devices(user_id, label) values (auth.uid(), row.label) on conflict (user_id) do nothing;
  return true;
end $$;

create or replace function device_status() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from devices where user_id = auth.uid());
$$;

create or replace function device_list(p_admin_pin text)
returns table(user_id uuid, label text, created_at timestamptz, this_one boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := staff_owner(p_admin_pin);
  return query select d.user_id, d.label, d.created_at, d.user_id = auth.uid() from devices d order by d.created_at;
end $$;

create or replace function device_remove(p_admin_pin text, p_user uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := staff_owner(p_admin_pin);
  if p_user = auth.uid() then raise exception 'No puedes quitar el teléfono que estás usando'; end if;
  delete from shifts where device_id = p_user;
  delete from devices where user_id = p_user;
end $$;

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

revoke execute on function staff_list(text), staff_upsert(text, uuid, text, text, text, boolean) from anon, public;

grant execute on function staff_list(text), staff_upsert(text, uuid, text, text, text, boolean) to authenticated;

revoke execute on function sales_report(text, timestamptz, timestamptz, text) from anon, public;

grant execute on function sales_report(text, timestamptz, timestamptz, text) to authenticated;

revoke execute on function staff_make_admin(text, uuid), staff_delete(text, uuid) from anon, public;

grant execute on function staff_make_admin(text, uuid), staff_delete(text, uuid) to authenticated;

revoke execute on function cash_summary(bigint) from anon, authenticated, public;

revoke execute on function cash_status(text), cash_open(text, int), cash_close(text, int), cash_history(text, int) from anon, public;

grant execute on function cash_status(text), cash_open(text, int), cash_close(text, int), cash_history(text, int) to authenticated;

revoke execute on function check_pin(text), pin_verify(text) from anon, authenticated, public;

revoke execute on function shift_start(text), shift_end(text) from anon, public;

grant execute on function shift_start(text), shift_end(text) to authenticated;

revoke execute on function cash_state() from anon, authenticated, public;

revoke execute on function shift_start(text) from anon, public;

grant execute on function shift_start(text) to authenticated;

revoke execute on function staff_owner(text) from anon, authenticated, public;

revoke execute on function staff_list(text), support_pin_create(text, int), support_pin_revoke(text) from anon, public;

grant execute on function staff_list(text), support_pin_create(text, int), support_pin_revoke(text) to authenticated;

revoke execute on function cash_state(), biz_day(timestamptz) from anon, authenticated, public;

revoke execute on function push_subscribe(text, text, text, text) from anon, public;

grant execute on function push_subscribe(text, text, text, text) to authenticated;

revoke execute on function new_device_code(text, uuid), device_code_bootstrap(text) from anon, authenticated, public;

revoke execute on function device_code_create(text, text), device_activate(text), device_status(), device_list(text), device_remove(text, uuid) from anon, public;

grant execute on function device_code_create(text, text), device_activate(text), device_status(), device_list(text), device_remove(text, uuid) to authenticated;

grant execute on function cash_summary(bigint) to service_role;

revoke execute on function report_request(bigint) from anon, authenticated, public;

revoke execute on function report_settings_get(text), report_settings_set(text, text[], text), report_send_test(text) from anon, public;

grant execute on function report_settings_get(text), report_settings_set(text, text[], text), report_send_test(text) to authenticated;

notify pgrst, 'reload schema';
