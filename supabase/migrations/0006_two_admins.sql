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
