-- Pancho Esquites POS — esquema inicial
-- Principio: el navegador solo tiene la anon key. Toda escritura sensible pasa por
-- funciones SECURITY DEFINER que validan PIN/rol y calculan precios en el servidor.

create extension if not exists pgcrypto;

-- ───────── Tablas ─────────
create table categories (
  id serial primary key,
  name text not null unique,
  sort int not null default 0
);

create table products (
  id serial primary key,
  category_id int not null references categories(id),
  name text not null,
  short_name text,
  price_cents int not null check (price_cents >= 0),
  photo_path text,               -- ruta en Storage (bucket "products")
  active boolean not null default true,
  sort int not null default 0
);

create table employees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pin_hash text not null,        -- crypt(pin, gen_salt('bf')) — nunca texto plano
  role text not null check (role in ('cajero','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Cuentas de Supabase Auth autorizadas (dueño / admins con correo y contraseña)
create table admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Dispositivos de caja (cuenta de Auth de la tablet/celular del puesto)
create table devices (
  user_id uuid primary key references auth.users(id) on delete cascade,
  label text not null
);

create table sales (
  id bigserial primary key,
  employee_id uuid not null references employees(id),
  device_id uuid references auth.users(id),
  total_cents int not null,
  pay_method text not null check (pay_method in ('cash','card','spei')),
  cash_received_cents int,
  voided boolean not null default false,
  voided_by uuid references employees(id),
  created_at timestamptz not null default now()
);

create table sale_items (
  id bigserial primary key,
  sale_id bigint not null references sales(id) on delete cascade,
  product_id int not null references products(id),
  qty int not null check (qty > 0),
  unit_price_cents int not null,
  note text
);

create table inventory_items (
  id text primary key,
  name text not null,
  unit text not null,
  stock numeric(12,3) not null default 0,
  min_stock numeric(12,3) not null default 0
);

create table recipes (
  product_id int references products(id) on delete cascade,
  item_id text references inventory_items(id) on delete cascade,
  qty numeric(12,4) not null,
  primary key (product_id, item_id)
);

create table inventory_moves (
  id bigserial primary key,
  item_id text not null references inventory_items(id),
  delta numeric(12,3) not null,
  reason text not null check (reason in ('venta','entrada','conteo','anulacion')),
  sale_id bigint references sales(id),
  by_user uuid,
  created_at timestamptz not null default now()
);

create table pin_attempts (
  device_id uuid not null,
  at timestamptz not null default now()
);
create index on pin_attempts(device_id, at);
create index on sales(created_at);

-- ───────── Helpers ─────────
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists(select 1 from admins where user_id = auth.uid());
$$;

create or replace function is_device() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists(select 1 from devices where user_id = auth.uid()) or is_admin();
$$;

-- Verifica PIN con límite de 5 intentos fallidos cada 5 minutos por dispositivo
create or replace function check_pin(p_pin text) returns employees
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
    raise exception 'PIN incorrecto';
  end if;
  delete from pin_attempts where device_id = auth.uid();
  return e;
end $$;

-- ───────── API para la caja ─────────
-- Inicio de sesión del empleado: devuelve solo nombre y rol
create or replace function pin_login(p_pin text)
returns table(employee_id uuid, name text, role text)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_pin);
  return query select e.id, e.name, e.role;
end $$;

-- Registrar venta: precios y total se calculan aquí, nunca se confía en el cliente
-- p_items: [{"product_id":1,"qty":2,"note":"sin mayonesa"}]
create or replace function register_sale(p_pin text, p_items jsonb, p_pay text, p_cash_cents int default null)
returns table(sale_id bigint, total_cents int)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees; s_id bigint; tot int := 0; it jsonb; pr products;
begin
  e := check_pin(p_pin);
  if jsonb_array_length(p_items) = 0 then raise exception 'Orden vacía'; end if;

  insert into sales(employee_id, device_id, total_cents, pay_method, cash_received_cents)
  values (e.id, auth.uid(), 0, p_pay, p_cash_cents) returning id into s_id;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into pr from products where id = (it->>'product_id')::int and active;
    if pr.id is null then raise exception 'Producto no válido'; end if;
    if (it->>'qty')::int not between 1 and 99 then raise exception 'Cantidad no válida'; end if;
    insert into sale_items(sale_id, product_id, qty, unit_price_cents, note)
    values (s_id, pr.id, (it->>'qty')::int, pr.price_cents, left(it->>'note', 120));
    tot := tot + pr.price_cents * (it->>'qty')::int;

    -- descuento de inventario según receta
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

-- Anular venta: solo con PIN de admin
create or replace function void_sale(p_admin_pin text, p_sale_id bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := check_pin(p_admin_pin);
  if e.role <> 'admin' then raise exception 'Solo un admin puede anular ventas'; end if;
  update sales set voided = true, voided_by = e.id where id = p_sale_id and not voided;
  -- regresar inventario
  update inventory_items i set stock = i.stock - m.delta
  from inventory_moves m where m.sale_id = p_sale_id and m.reason = 'venta' and m.item_id = i.id;
  insert into inventory_moves(item_id, delta, reason, sale_id, by_user)
  select item_id, -delta, 'anulacion', sale_id, e.id from inventory_moves
  where sale_id = p_sale_id and reason = 'venta';
end $$;

-- ───────── API para el admin (sesión de Auth con correo y contraseña) ─────────
create or replace function admin_upsert_employee(p_id uuid, p_name text, p_pin text, p_role text, p_active boolean)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare new_id uuid;
begin
  if not is_admin() then raise exception 'No autorizado'; end if;
  if p_pin is not null and p_pin !~ '^\d{4,6}$' then raise exception 'PIN de 4 a 6 números'; end if;
  if p_pin is not null and exists(select 1 from employees where active and pin_hash = crypt(p_pin, pin_hash) and id is distinct from p_id) then
    raise exception 'Ese PIN ya lo usa otro empleado';
  end if;
  if p_id is null then
    insert into employees(name, pin_hash, role) values (p_name, crypt(p_pin, gen_salt('bf', 10)), p_role) returning id into new_id;
    return new_id;
  end if;
  update employees set name = p_name, role = p_role, active = p_active,
    pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf', 10)) end
  where id = p_id;
  return p_id;
end $$;

create or replace function admin_inventory_move(p_item text, p_qty numeric, p_kind text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare cur numeric;
begin
  if not is_admin() then raise exception 'No autorizado'; end if;
  select stock into cur from inventory_items where id = p_item for update;
  if p_kind = 'entrada' then
    update inventory_items set stock = stock + p_qty where id = p_item;
    insert into inventory_moves(item_id, delta, reason, by_user) values (p_item, p_qty, 'entrada', auth.uid());
  elsif p_kind = 'conteo' then
    update inventory_items set stock = p_qty where id = p_item;
    insert into inventory_moves(item_id, delta, reason, by_user) values (p_item, p_qty - cur, 'conteo', auth.uid());
  else raise exception 'Tipo no válido'; end if;
end $$;

-- ───────── RLS ─────────
alter table categories enable row level security;
alter table products enable row level security;
alter table employees enable row level security;
alter table admins enable row level security;
alter table devices enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table inventory_items enable row level security;
alter table recipes enable row level security;
alter table inventory_moves enable row level security;
alter table pin_attempts enable row level security;

-- Menú: lo leen cajas y admins; solo admin lo modifica
create policy menu_read on categories for select using (is_device());
create policy menu_admin on categories for all using (is_admin()) with check (is_admin());
create policy prod_read on products for select using (is_device());
create policy prod_admin on products for all using (is_admin()) with check (is_admin());

-- Ventas, inventario, empleados: solo admin lee (la caja escribe vía funciones)
create policy sales_admin on sales for select using (is_admin());
create policy items_admin on sale_items for select using (is_admin());
create policy inv_admin on inventory_items for all using (is_admin()) with check (is_admin());
create policy rec_admin on recipes for all using (is_admin()) with check (is_admin());
create policy moves_admin on inventory_moves for select using (is_admin());
create policy emp_admin_read on employees for select using (is_admin());
create policy devices_admin on devices for all using (is_admin()) with check (is_admin());
create policy admins_self on admins for select using (user_id = auth.uid());
-- pin_attempts: sin políticas = nadie desde el cliente

-- Nunca exponer pin_hash, ni siquiera al admin
revoke select (pin_hash) on employees from anon, authenticated;

-- Las funciones solo para usuarios con sesión
revoke execute on all functions in schema public from anon, public;
grant execute on function pin_login(text), register_sale(text, jsonb, text, int), void_sale(text, bigint),
  admin_upsert_employee(uuid, text, text, text, boolean), admin_inventory_move(text, numeric, text),
  is_admin(), is_device() to authenticated;
revoke execute on function check_pin(text) from authenticated;

-- ───────── Rol de solo lectura para respaldos ─────────
-- Crear manualmente con contraseña fuerte (ver README):
--   create role backup_ro login password '...';
--   grant pg_read_all_data to backup_ro;

