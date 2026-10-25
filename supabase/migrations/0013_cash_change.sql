-- Cierre de caja con desglose: efectivo recibido y cambio entregado.
-- Efectivo esperado = fondo + recibido − cambio (= fondo + total de ventas en efectivo). Se puede correr más de una vez.
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

