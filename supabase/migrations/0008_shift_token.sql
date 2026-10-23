-- PIN una sola vez por turno: al entrar se entrega un pase ("T:<token>") que sustituye al PIN
-- en las demás funciones. Vence tras 3 horas sin uso o si el empleado se desactiva.
create table shifts (
  token_hash text primary key,
  employee_id uuid not null references employees(id) on delete cascade,
  device_id uuid not null,
  started_at timestamptz not null default now(),
  last_used timestamptz not null default now()
);
alter table shifts enable row level security;
-- sin políticas: nadie la lee desde el cliente

create or replace function check_pin(p_pin text) returns employees
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; fails int; t shifts;
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

  select count(*) into fails from pin_attempts
    where device_id = auth.uid() and at > now() - interval '5 minutes';
  if fails >= 5 then raise exception 'Demasiados intentos. Espera 5 minutos.'; end if;

  select * into e from employees
    where active and pin_hash = crypt(p_pin, pin_hash) limit 1;
  if e.id is null then
    insert into pin_attempts(device_id) values (auth.uid());
    raise exception 'PIN incorrecto';
  end if;
  delete from pin_attempts where device_id = auth.uid();
  return e;
end $$;

create or replace function shift_start(p_pin text)
returns table(employee_id uuid, name text, role text, token text)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; tk text;
begin
  if p_pin like 'T:%' then raise exception 'PIN incorrecto'; end if;
  e := check_pin(p_pin);
  tk := encode(gen_random_bytes(24), 'hex');
  delete from shifts where last_used < now() - interval '1 day';
  insert into shifts(token_hash, employee_id, device_id) values (encode(digest(tk, 'sha256'), 'hex'), e.id, auth.uid());
  return query select e.id, e.name, e.role, 'T:' || tk;
end $$;

create or replace function shift_end(p_token text) returns void
language sql security definer set search_path = public, extensions as $$
  delete from shifts where token_hash = encode(digest(substr(p_token, 3), 'sha256'), 'hex') and device_id = auth.uid();
$$;

revoke execute on function check_pin(text) from anon, authenticated, public;
revoke execute on function shift_start(text), shift_end(text) from anon, public;
grant execute on function shift_start(text), shift_end(text) to authenticated;
