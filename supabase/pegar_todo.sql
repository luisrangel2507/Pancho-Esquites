-- Pancho Esquites: TODO lo pendiente en un solo bloque (empleados, informes, 2 admins, caja y turno).
-- Se puede correr más de una vez sin error. Pegar completo en Supabase → SQL Editor → Run.

-- ═════ 0003_staff ═════
-- Empleados administrados desde la caja: el admin se identifica con su PIN (sin sesión de Auth extra)
create or replace function staff_list(p_admin_pin text)
returns table(id uuid, name text, role text, active boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede ver empleados'; end if;
  return query select x.id, x.name, x.role, x.active from employees x order by x.active desc, x.name;
end $$;

create or replace function staff_upsert(p_admin_pin text, p_id uuid, p_name text, p_pin text, p_role text, p_active boolean)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare e employees; new_id uuid;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede editar empleados'; end if;
  if p_role not in ('cajero', 'admin') then raise exception 'Rol no válido'; end if;
  if p_id is null and p_pin is null then raise exception 'Falta el PIN'; end if;
  if p_pin is not null and p_pin !~ '^\d{4,6}$' then raise exception 'PIN de 4 a 6 números'; end if;
  if p_pin is not null and exists(select 1 from employees where active and pin_hash = crypt(p_pin, pin_hash) and id is distinct from p_id) then
    raise exception 'Ese PIN ya lo usa otro empleado';
  end if;
  if p_id = e.id and (not p_active or p_role <> 'admin') then raise exception 'No puedes quitarte tu propio acceso'; end if;
  if p_id is null then
    insert into employees(name, pin_hash, role) values (trim(p_name), crypt(p_pin, gen_salt('bf', 10)), p_role) returning employees.id into new_id;
    return new_id;
  end if;
  update employees set name = trim(p_name), role = p_role, active = p_active,
    pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf', 10)) end
  where employees.id = p_id;
  return p_id;
end $$;

revoke execute on function staff_list(text), staff_upsert(text, uuid, text, text, text, boolean) from anon, public;
grant execute on function staff_list(text), staff_upsert(text, uuid, text, text, text, boolean) to authenticated;

-- ═════ 0004_reports ═════
-- Informe de ventas para el admin (se identifica con su PIN). Excluye ventas anuladas de los totales.
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

revoke execute on function sales_report(text, timestamptz, timestamptz, text) from anon, public;
grant execute on function sales_report(text, timestamptz, timestamptz, text) to authenticated;

-- ═════ 0005_single_admin ═════
-- Un solo administrador activo a la vez, pasar el mando y borrar empleados sin ventas
create or replace function staff_upsert(p_admin_pin text, p_id uuid, p_name text, p_pin text, p_role text, p_active boolean)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare e employees; new_id uuid;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede editar empleados'; end if;
  if p_role not in ('cajero', 'admin') then raise exception 'Rol no válido'; end if;
  if p_id is null and p_pin is null then raise exception 'Falta el PIN'; end if;
  if p_pin is not null and p_pin !~ '^\d{4,6}$' then raise exception 'PIN de 4 a 6 números'; end if;
  if p_pin is not null and exists(select 1 from employees where active and pin_hash = crypt(p_pin, pin_hash) and id is distinct from p_id) then
    raise exception 'Ese PIN ya lo usa otro empleado';
  end if;
  if p_id = e.id and (not p_active or p_role <> 'admin') then raise exception 'No puedes quitarte tu propio acceso'; end if;
  if p_role = 'admin' and p_active and exists(select 1 from employees where role = 'admin' and active and id is distinct from p_id) then
    raise exception 'Solo puede haber un administrador activo';
  end if;
  if p_id is null then
    insert into employees(name, pin_hash, role) values (trim(p_name), crypt(p_pin, gen_salt('bf', 10)), p_role) returning employees.id into new_id;
    return new_id;
  end if;
  update employees set name = trim(p_name), role = p_role, active = p_active,
    pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf', 10)) end
  where employees.id = p_id;
  return p_id;
end $$;

-- Pasa el mando: el empleado elegido queda como admin y quien lo pasa queda como cajero
create or replace function staff_make_admin(p_admin_pin text, p_to uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede pasar el mando'; end if;
  if p_to = e.id then raise exception 'Ya eres el admin'; end if;
  if not exists(select 1 from employees where id = p_to and active) then raise exception 'Empleado no válido o inactivo'; end if;
  update employees set role = 'cajero' where role = 'admin' and id <> p_to;
  update employees set role = 'admin' where id = p_to;
end $$;

-- Borra un empleado solo si nunca registró ventas
create or replace function staff_delete(p_admin_pin text, p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede borrar empleados'; end if;
  if p_id = e.id then raise exception 'No puedes borrarte a ti mismo'; end if;
  if exists(select 1 from sales where employee_id = p_id or voided_by = p_id) then
    raise exception 'Ya tiene ventas registradas; solo puedes desactivarlo';
  end if;
  delete from employees where id = p_id;
end $$;

revoke execute on function staff_make_admin(text, uuid), staff_delete(text, uuid) from anon, public;
grant execute on function staff_make_admin(text, uuid), staff_delete(text, uuid) to authenticated;

-- ═════ 0006_two_admins ═════
-- Hasta 2 administradores activos. "Hacer admin" suma otro sin quitarte el tuyo.
create or replace function staff_upsert(p_admin_pin text, p_id uuid, p_name text, p_pin text, p_role text, p_active boolean)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare e employees; new_id uuid;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede editar empleados'; end if;
  if p_role not in ('cajero', 'admin') then raise exception 'Rol no válido'; end if;
  if p_id is null and p_pin is null then raise exception 'Falta el PIN'; end if;
  if p_pin is not null and p_pin !~ '^\d{4,6}$' then raise exception 'PIN de 4 a 6 números'; end if;
  if p_pin is not null and exists(select 1 from employees where active and pin_hash = crypt(p_pin, pin_hash) and id is distinct from p_id) then
    raise exception 'Ese PIN ya lo usa otro empleado';
  end if;
  if p_id = e.id and (not p_active or p_role <> 'admin') then raise exception 'No puedes quitarte tu propio acceso'; end if;
  if p_role = 'admin' and p_active and (select count(*) from employees where role = 'admin' and active and id is distinct from p_id) >= 2 then
    raise exception 'Solo puede haber 2 administradores activos';
  end if;
  if p_id is null then
    insert into employees(name, pin_hash, role) values (trim(p_name), crypt(p_pin, gen_salt('bf', 10)), p_role) returning employees.id into new_id;
    return new_id;
  end if;
  update employees set name = trim(p_name), role = p_role, active = p_active,
    pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf', 10)) end
  where employees.id = p_id;
  return p_id;
end $$;

create or replace function staff_make_admin(p_admin_pin text, p_to uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede dar permisos de admin'; end if;
  if not exists(select 1 from employees where id = p_to and active) then raise exception 'Empleado no válido o inactivo'; end if;
  if (select count(*) from employees where role = 'admin' and active and id <> p_to) >= 2 then
    raise exception 'Solo puede haber 2 administradores activos';
  end if;
  update employees set role = 'admin' where id = p_to;
end $$;

-- ═════ 0007_cash ═════
-- Apertura y cierre de caja: una sesión abierta a la vez; las ventas se ligan a la sesión abierta.
-- Se puede correr más de una vez sin error.
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

-- Resumen de una sesión (uso interno; el efectivo esperado = fondo + ventas en efectivo no anuladas)
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
    'counted_cents', c.counted_cents)
  from cash_sessions c
  join employees o on o.id = c.opened_by
  left join employees cl on cl.id = c.closed_by
  left join lateral (
    select count(*) filter (where not s.voided) as tickets,
      sum(s.total_cents) filter (where not s.voided) as total,
      sum(s.total_cents) filter (where not s.voided and s.pay_method = 'cash') as cash,
      sum(s.total_cents) filter (where not s.voided and s.pay_method = 'card') as card,
      sum(s.total_cents) filter (where not s.voided and s.pay_method = 'spei') as spei,
      count(*) filter (where s.voided) as voided,
      sum(s.total_cents) filter (where s.voided) as voided_cents
    from sales s where s.session_id = c.id) x on true
  where c.id = p_id
$$;

create or replace function cash_status(p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; sid bigint;
begin
  e := check_pin(p_pin);
  select id into sid from cash_sessions where closed_at is null;
  if sid is null then return jsonb_build_object('open', false); end if;
  return cash_summary(sid);
end $$;

create or replace function cash_open(p_pin text, p_opening_cents int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; sid bigint;
begin
  e := check_pin(p_pin);
  if p_opening_cents is null or p_opening_cents < 0 or p_opening_cents > 100000000 then raise exception 'Monto no válido'; end if;
  begin
    insert into cash_sessions(opened_by, opening_cents) values (e.id, p_opening_cents) returning id into sid;
  exception when unique_violation then
    raise exception 'Ya hay una caja abierta';
  end;
  return cash_summary(sid);
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
  return cash_summary(sid);
end $$;

create or replace function cash_history(p_admin_pin text, p_limit int default 20) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede ver los cierres'; end if;
  return coalesce((select jsonb_agg(cash_summary(t.id) order by t.id desc)
    from (select id from cash_sessions order by id desc limit least(coalesce(p_limit, 20), 60)) t), '[]'::jsonb);
end $$;

-- Registrar venta: ahora exige caja abierta y la liga a la sesión
create or replace function register_sale(p_pin text, p_items jsonb, p_pay text, p_cash_cents int default null)
returns table(sale_id bigint, total_cents int)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; s_id bigint; tot int := 0; it jsonb; pr products; cs bigint;
begin
  e := check_pin(p_pin);
  if jsonb_array_length(p_items) = 0 then raise exception 'Orden vacía'; end if;
  select id into cs from cash_sessions where closed_at is null;
  if cs is null then raise exception 'Abre la caja primero'; end if;

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

revoke execute on function cash_summary(bigint) from anon, authenticated, public;
revoke execute on function cash_status(text), cash_open(text, int), cash_close(text, int), cash_history(text, int) from anon, public;
grant execute on function cash_status(text), cash_open(text, int), cash_close(text, int), cash_history(text, int) to authenticated;

-- ═════ 0008_shift_token ═════
-- PIN una sola vez por turno: al entrar se entrega un pase ("T:<token>") que sustituye al PIN
-- en las demás funciones. Vence tras 3 horas sin uso o si el empleado se desactiva.
create table if not exists shifts (
  token_hash text primary key,
  employee_id uuid not null references employees(id) on delete cascade,
  device_id uuid not null,
  started_at timestamptz not null default now(),
  last_used timestamptz not null default now()
);
alter table shifts enable row level security;
-- sin políticas: nadie la lee desde el cliente

-- Verifica un PIN sin lanzar error si es incorrecto: así el intento fallido SÍ se guarda
-- (un error deshace todo lo hecho en la llamada, y el límite de intentos nunca se aplicaba).
create or replace function pin_verify(p_pin text) returns employees
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; fails int;
begin
  if not is_device() then raise exception 'Dispositivo no autorizado'; end if;
  select count(*) into fails from pin_attempts
    where device_id = auth.uid() and at > now() - interval '5 minutes';
  if fails >= 5 then raise exception 'Demasiados intentos. Espera 5 minutos.'; end if;
  select * into e from employees
    where active and pin_hash = crypt(p_pin, pin_hash) limit 1;
  if e.id is null then
    insert into pin_attempts(device_id) values (auth.uid());
    return null;
  end if;
  delete from pin_attempts where device_id = auth.uid();
  -- costo 8 en vez de 10: unas 7 veces más rápido; con 6 dígitos la protección real es el límite de intentos
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
      select * into e from employees where id = t.employee_id and active;
    end if;
    if e.id is null then raise exception 'Turno vencido, ingresa tu PIN'; end if;
    return e;
  end if;

  e := pin_verify(p_pin);
  if e.id is null then raise exception 'PIN incorrecto'; end if;
  return e;
end $$;

-- Entrar al turno: PIN incorrecto devuelve 0 filas (sin error) para que cuente el intento.
-- Devuelve también el estado de la caja para entrar en un solo viaje. Requiere 0007_cash.
drop function if exists shift_start(text);
create function shift_start(p_pin text)
returns table(employee_id uuid, name text, role text, token text, cash jsonb)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; tk text; sid bigint;
begin
  if p_pin like 'T:%' then raise exception 'PIN incorrecto'; end if;
  e := pin_verify(p_pin);
  if e.id is null then return; end if;
  tk := encode(gen_random_bytes(24), 'hex');
  delete from shifts where last_used < now() - interval '1 day';
  insert into shifts(token_hash, employee_id, device_id) values (encode(digest(tk, 'sha256'), 'hex'), e.id, auth.uid());
  select id into sid from cash_sessions where closed_at is null;
  return query select e.id, e.name, e.role, 'T:' || tk,
    case when sid is null then jsonb_build_object('open', false) else cash_summary(sid) end;
end $$;

-- Entrada vieja (app sin pase de turno): mismo arreglo del límite de intentos
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

revoke execute on function check_pin(text), pin_verify(text) from anon, authenticated, public;
revoke execute on function shift_start(text), shift_end(text) from anon, public;
grant execute on function shift_start(text), shift_end(text) to authenticated;

notify pgrst, 'reload schema';
