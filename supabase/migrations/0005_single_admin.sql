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
