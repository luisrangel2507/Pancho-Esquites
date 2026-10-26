-- Activación de teléfonos sin contraseña en la app. Cada teléfono inicia sesión anónima (Supabase
-- "anonymous sign-ins") y se activa UNA vez con un código de 8 caracteres que genera el dueño (dura 30 min,
-- un solo uso). Cada teléfono queda con su propia identidad. Se puede correr más de una vez.
alter table devices add column if not exists created_at timestamptz not null default now();
-- La venta guarda qué teléfono la registró, pero sin enlace obligatorio a auth.users: así se pueden borrar
-- teléfonos anónimos viejos y restaurar un respaldo en otro proyecto sin perder ventas.
alter table sales drop constraint if exists sales_device_id_fkey;

create table if not exists device_codes (
  code_hash text primary key,
  label text not null,
  created_by uuid references employees(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid
);
alter table device_codes enable row level security;

create table if not exists device_code_attempts (at timestamptz not null default now(), uid uuid);
create index if not exists device_code_attempts_at on device_code_attempts(at);
alter table device_code_attempts enable row level security;
revoke all on device_codes, device_code_attempts from anon, authenticated;

-- 8 caracteres sin letras confusas (sin 0/O, 1/I/L): 32^8 ≈ 1 billón de combinaciones
create or replace function new_device_code(p_label text, p_by uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare abc text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789X'; raw bytea := gen_random_bytes(8); c text := ''; until timestamptz;
begin
  for i in 0..7 loop c := c || substr(abc, (get_byte(raw, i) % 32) + 1, 1); end loop;
  until := now() + interval '30 minutes';
  delete from device_codes where expires_at < now() - interval '1 day';
  insert into device_codes(code_hash, label, created_by, expires_at)
    values (encode(digest(c, 'sha256'), 'hex'), coalesce(nullif(trim(p_label), ''), 'Caja'), p_by, until);
  return jsonb_build_object('code', substr(c, 1, 4) || '-' || substr(c, 5, 4), 'expires_at', until);
end $$;

-- El dueño (admin, no soporte) genera el código desde la app
create or replace function device_code_create(p_admin_pin text, p_label text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := staff_owner(p_admin_pin);
  return new_device_code(p_label, e.id);
end $$;

-- Primer teléfono (o si se perdieron todos): correr en Supabase → SQL Editor:
--   select device_code_bootstrap('Caja 1');
create or replace function device_code_bootstrap(p_label text default 'Caja') returns text
language sql security definer set search_path = public, extensions as $$
  select new_device_code(p_label, null)->>'code';
$$;

-- El teléfono canjea el código. Código incorrecto devuelve false (sin error) para que el intento se guarde.
create or replace function device_activate(p_code text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); row device_codes;
begin
  if auth.uid() is null then raise exception 'Sin sesión'; end if;
  if exists(select 1 from devices where user_id = auth.uid()) then return true; end if;
  if (select count(*) from device_code_attempts where at > now() - interval '15 minutes') >= 20 then
    raise exception 'Demasiados intentos. Espera 15 minutos.';
  end if;
  select * into row from device_codes
    where code_hash = encode(digest(c, 'sha256'), 'hex') and used_at is null and expires_at > now()
    for update;
  if row.code_hash is null then
    insert into device_code_attempts(uid) values (auth.uid());
    return false;
  end if;
  update device_codes set used_at = now(), used_by = auth.uid() where code_hash = row.code_hash;
  insert into devices(user_id, label) values (auth.uid(), row.label) on conflict (user_id) do nothing;
  return true;
end $$;

create or replace function device_status() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from devices where user_id = auth.uid());
$$;

create or replace function device_list(p_admin_pin text)
returns table(user_id uuid, label text, created_at timestamptz, this_one boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := staff_owner(p_admin_pin);
  return query select d.user_id, d.label, d.created_at, d.user_id = auth.uid() from devices d order by d.created_at;
end $$;

-- Quitar un teléfono: deja de poder usar la caja al momento (sus pases de turno se borran)
create or replace function device_remove(p_admin_pin text, p_user uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e employees;
begin
  e := staff_owner(p_admin_pin);
  if p_user = auth.uid() then raise exception 'No puedes quitar el teléfono que estás usando'; end if;
  delete from shifts where device_id = p_user;
  delete from devices where user_id = p_user;
end $$;

revoke execute on function new_device_code(text, uuid), device_code_bootstrap(text) from anon, authenticated, public;
revoke execute on function device_code_create(text, text), device_activate(text), device_status(), device_list(text), device_remove(text, uuid) from anon, public;
grant execute on function device_code_create(text, text), device_activate(text), device_status(), device_list(text), device_remove(text, uuid) to authenticated;
