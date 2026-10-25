-- Cierre olvidado: el día de operación va de 5:00 am a 4:59 am (hora de Ciudad de México).
-- Una caja abierta de un día anterior queda "pendiente": no se cobra hasta cerrarla con el efectivo contado.
-- Se puede correr más de una vez.
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

revoke execute on function cash_state(), biz_day(timestamptz) from anon, authenticated, public;
