-- PIN de soporte: el dueño (admin) genera un PIN temporal para el Desarrollador.
-- Entra como admin sin ocupar uno de los 2 lugares, vence solo y se revoca al momento.
-- No puede administrar empleados ni generar otro PIN de soporte. Se puede correr más de una vez.
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

-- Admin "del negocio": admin que no es soporte
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

-- Genera un PIN de soporte nuevo (anula el anterior) y lo devuelve una sola vez
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

revoke execute on function staff_owner(text) from anon, authenticated, public;
revoke execute on function staff_list(text), support_pin_create(text, int), support_pin_revoke(text) from anon, public;
grant execute on function staff_list(text), support_pin_create(text, int), support_pin_revoke(text) to authenticated;
