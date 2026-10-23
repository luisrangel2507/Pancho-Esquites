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
