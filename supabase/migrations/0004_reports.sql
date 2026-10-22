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
