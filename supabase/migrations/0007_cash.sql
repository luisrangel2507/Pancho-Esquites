-- Apertura y cierre de caja: una sesión abierta a la vez; las ventas se ligan a la sesión abierta.
create table cash_sessions (
  id bigserial primary key,
  opened_by uuid not null references employees(id),
  opened_at timestamptz not null default now(),
  opening_cents int not null check (opening_cents >= 0),
  closed_by uuid references employees(id),
  closed_at timestamptz,
  expected_cents int,
  counted_cents int check (counted_cents >= 0)
);
create unique index one_open_cash_session on cash_sessions ((true)) where closed_at is null;
alter table cash_sessions enable row level security;
create policy cash_admin on cash_sessions for select using (is_admin());

alter table sales add column session_id bigint references cash_sessions(id);
create index on sales(session_id);

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
