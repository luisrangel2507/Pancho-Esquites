-- La caja se abre una sola vez al día (hora de Ciudad de México) y solo la abre un administrador.
create or replace function cash_state() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select cash_summary(id) from cash_sessions where closed_at is null),
    jsonb_build_object('open', false, 'today_closed', exists(
      select 1 from cash_sessions
      where (opened_at at time zone 'America/Mexico_City')::date = (now() at time zone 'America/Mexico_City')::date)))
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
  -- evita que dos admins la abran al mismo tiempo
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

revoke execute on function cash_state() from anon, authenticated, public;
revoke execute on function shift_start(text) from anon, public;
grant execute on function shift_start(text) to authenticated;
