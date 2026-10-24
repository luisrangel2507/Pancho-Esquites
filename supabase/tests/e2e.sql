-- Prueba de punta a punta: entrar con PIN, caja, ventas, informes, empleados, pases y permisos.
-- Corre como la caja (rol authenticated). Al final lista cada prueba con OK o FALLA.
\set ON_ERROR_STOP 1
-- ── preparación (como dueño de la base) ──
create schema tst; grant usage on schema tst to authenticated, anon;
create table tst.res(n serial, name text, ok boolean, info text); grant all on tst.res, tst.res_n_seq to authenticated, anon;
create function tst.chk(name text, ok boolean, info text default '') returns void language sql as $$ insert into tst.res(name, ok, info) values (name, ok, info) $$;
create function tst.err(name text, q text, pat text) returns void language plpgsql as $$
begin
  begin execute q; perform tst.chk(name, false, 'no falló');
  exception when others then perform tst.chk(name, sqlerrm ilike '%'||pat||'%', sqlerrm); end;
end $$;
grant execute on all functions in schema tst to authenticated, anon;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-00000000000a','admin@esquites.com'),('00000000-0000-0000-0000-00000000000b','otra@esquites.com');
insert into devices(user_id,label) values ('00000000-0000-0000-0000-00000000000a','Caja 1'),('00000000-0000-0000-0000-00000000000b','Caja 2');
insert into employees(name,pin_hash,role) values ('Dueño', extensions.crypt('111111', extensions.gen_salt('bf',10)),'admin'),('guero', extensions.crypt('222222', extensions.gen_salt('bf',10)),'cajero');
-- ── como la caja (rol authenticated, sesión del dispositivo) ──
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$
declare tk text; tk2 text; r jsonb; s1 bigint; s2 bigint; n int; prod_ch int; prod_md int; t1 int;
begin
  select id into prod_ch from products where short_name='Chico';
  select id into prod_md from products where short_name='Mediano';
  perform tst.chk('caja ve el menú', prod_ch is not null and prod_md is not null);

  perform tst.chk('PIN incorrecto no entra', (select count(*) from shift_start('999999')) = 0);
  select token, cash into tk, r from shift_start('111111');
  perform tst.chk('entrar con PIN da pase', tk like 'T:%', tk);
  perform tst.chk('la entrada trae el estado de la caja', (r->>'open')::boolean = false and (r->>'today_closed')::boolean = false, r::text);
  select token into tk2 from shift_start('222222');
  perform tst.chk('pase de cajero', tk2 like 'T:%');
  perform tst.err('un pase no sirve como PIN para otro pase', format($q$select shift_start(%L)$q$, tk), 'PIN incorrecto');
  perform tst.chk('pin_login viejo sigue sirviendo', (select name from pin_login('111111')) = 'Dueño');

  r := cash_status(tk);
  perform tst.chk('caja inicia cerrada', (r->>'open')::boolean = false, r::text);
  perform tst.err('no cobra sin caja abierta', format($q$select * from register_sale(%L, '[{"product_id":%s,"qty":1}]', 'cash', 5000)$q$, tk, prod_ch), 'Abre la caja');
  perform tst.err('fondo negativo rechazado', format($q$select cash_open(%L, -1)$q$, tk), 'Monto no válido');
  perform tst.err('cajero no puede abrir la caja', format($q$select cash_open(%L, 0)$q$, tk2), 'Solo un administrador');
  r := cash_open(tk, 50000);
  perform tst.chk('admin abre caja con $500', (r->>'open')::boolean and (r->>'opening_cents')::int = 50000, r::text);
  perform tst.err('no se abren dos cajas', format($q$select cash_open(%L, 0)$q$, tk), 'Ya hay una caja abierta');

  select sale_id, total_cents into s1, t1 from register_sale(tk2, format('[{"product_id":%s,"qty":2}]', prod_ch)::jsonb, 'cash', 10000);
  select sale_id into s2 from register_sale(tk2, format('[{"product_id":%s,"qty":1}]', prod_md)::jsonb, 'card', null);
  perform tst.chk('cobra efectivo y tarjeta', s1 is not null and s2 is not null);
  perform tst.chk('precio lo pone la base (2 × $35 = $70)', t1 = 7000, t1::text);
  select count(*) into n from sales;
  perform tst.err('efectivo insuficiente rechazado', format($q$select * from register_sale(%L, '[{"product_id":%s,"qty":1}]', 'cash', 100)$q$, tk2, prod_ch), 'no cubre');
  perform tst.chk('venta rechazada no deja basura', (select count(*) from sales) = n);
  perform tst.err('cantidad 0 rechazada', format($q$select * from register_sale(%L, '[{"product_id":%s,"qty":0}]', 'card', null)$q$, tk2, prod_ch), 'Cantidad');
  perform tst.err('producto inexistente rechazado', format($q$select * from register_sale(%L, '[{"product_id":99999,"qty":1}]', 'card', null)$q$, tk2), 'Producto no válido');
  perform tst.err('orden vacía rechazada', format($q$select * from register_sale(%L, '[]', 'card', null)$q$, tk2), 'vacía');

  perform tst.err('cajero no ve informes', format($q$select sales_report(%L, now()-interval '1 day', now()+interval '1 day')$q$, tk2), 'Solo un admin');
  r := sales_report(tk, now()-interval '1 day', now()+interval '1 day');
  perform tst.chk('informe: $115 y 2 tickets', (r->'totals'->>'cents')::int = 11500 and (r->'totals'->>'tickets')::int = 2, (r->'totals')::text);
  perform tst.chk('informe: top tiene Esquite chico', r->'top' @> '[{"name":"Esquite chico","qty":2}]', (r->'top')::text);

  perform tst.err('cajero no puede anular', format($q$select void_sale(%L, %s)$q$, tk2, s2), 'Solo un admin');
  perform void_sale(tk, s2);
  r := cash_status(tk);
  perform tst.chk('caja: esperado = $500 + $70 efectivo', (r->>'expected_cents')::int = 57000 and (r->>'voided')::int = 1, r::text);

  r := cash_close(tk2, 56000);
  perform tst.chk('cierre guarda contado y esperado', (r->>'open')::boolean = false and (r->>'counted_cents')::int = 56000 and (r->>'expected_cents')::int = 57000, r::text);
  perform tst.err('no se cierra dos veces', format($q$select cash_close(%L, 0)$q$, tk2), 'No hay caja abierta');
  r := cash_status(tk2);
  perform tst.chk('después del cierre: caja de hoy ya usada', (r->>'open')::boolean = false and (r->>'today_closed')::boolean, r::text);
  perform tst.err('no se abre otra vez el mismo día', format($q$select cash_open(%L, 0)$q$, tk), 'ya se abrió y se cerró');
  perform tst.err('no se cobra con la caja cerrada', format($q$select * from register_sale(%L, '[{"product_id":%s,"qty":1}]', 'card', null)$q$, tk2, prod_ch), 'Abre la caja');
  reset role; update cash_sessions set opened_at = opened_at - interval '1 day', closed_at = closed_at - interval '1 day'; set role authenticated;
  perform tst.chk('al día siguiente se puede abrir', (cash_status(tk2)->>'today_closed')::boolean = false);
  r := cash_history(tk, 10);
  perform tst.chk('historial de cierres', jsonb_array_length(r) = 1, r::text);
  perform tst.err('cajero no ve historial', format($q$select cash_history(%L, 10)$q$, tk2), 'Solo un admin');

  perform tst.err('cajero no administra empleados', format($q$select staff_list(%L)$q$, tk2), 'Solo un admin');
  perform staff_upsert(tk, null, 'Ana', '333333', 'cajero', true);
  perform tst.err('PIN repetido rechazado', format($q$select staff_upsert(%L, null, 'Beto', '333333', 'cajero', true)$q$, tk), 'ya lo usa');
  perform tst.chk('staff_list muestra 3', jsonb_array_length(to_jsonb(array(select staff_list(tk)))) = 3);
  perform staff_make_admin(tk, (select id from staff_list(tk) where name='Ana'));
  perform tst.err('tercer admin rechazado', format($q$select staff_make_admin(%L, %L)$q$, tk, (select id from staff_list(tk) where name='guero')), '2 administradores');
  perform tst.err('no puedes quitarte tu acceso', format($q$select staff_upsert(%L, %L, 'Dueño', null, 'cajero', true)$q$, tk, (select id from staff_list(tk) where name='Dueño')), 'propio acceso');
  perform tst.err('no se borra quien tiene ventas', format($q$select staff_delete(%L, %L)$q$, tk, (select id from staff_list(tk) where name='guero')), 'ventas registradas');

  -- desactivar al cajero invalida su pase al momento
  perform staff_upsert(tk, (select id from staff_list(tk) where name='guero'), 'guero', null, 'cajero', false);
  perform tst.err('pase de empleado desactivado no sirve', format($q$select cash_status(%L)$q$, tk2), 'Turno vencido');
  -- pase vencido por 3 horas sin uso
  reset role; update shifts set last_used = now() - interval '3 hours 1 minute'; set role authenticated;
  perform tst.err('pase vence a las 3 horas', format($q$select cash_status(%L)$q$, tk), 'Turno vencido');
  perform shift_end(tk);
end $$;

reset role;
select tst.chk('PIN se re-guarda con costo 8 al entrar', (select pin_hash like '$2a$08$%' from employees where name = 'Dueño'));
set role authenticated;
-- otro dispositivo no puede usar un pase ajeno
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
create temp table tk as select token from shift_start('111111');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select tst.err('pase de otra caja no sirve', format($q$select cash_status(%L)$q$, (select token from tk)), 'Turno vencido');
-- sesión que no es caja
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ff',false);
select tst.err('cuenta que no es caja rechazada', $q$select shift_start('111111')$q$, 'Dispositivo no autorizado');
-- bloqueo por intentos
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select tst.chk('fallo 1 no entra', (select count(*) from shift_start('000001')) = 0);
select tst.chk('fallo 2 no entra', (select count(*) from shift_start('000002')) = 0);
select tst.chk('fallo 3 no entra', (select count(*) from shift_start('000003')) = 0);
select tst.chk('fallo 4 no entra', (select count(*) from shift_start('000004')) = 0);
select tst.chk('fallo 5 no entra', (select count(*) from shift_start('000005')) = 0);
select tst.err('6.º intento bloqueado aunque el PIN sea bueno', $q$select shift_start('111111')$q$, 'Demasiados intentos');
select tst.err('bloqueo también en la entrada vieja', $q$select pin_login('111111')$q$, 'Demasiados intentos');
reset role; update pin_attempts set at = now() - interval '6 minutes'; set role authenticated;
select tst.chk('a los 5 minutos se desbloquea', (select count(*) from shift_start('111111')) = 1);
select tst.err('pin_verify no se llama desde la app', $q$select pin_verify('111111')$q$, 'permission denied');
-- permisos directos
select tst.err('check_pin no se llama desde la app', $q$select check_pin('111111')$q$, 'permission denied');
select tst.err('cash_summary no se llama desde la app', $q$select cash_summary(1)$q$, 'permission denied');
select tst.chk('la caja no puede leer los pases', (select count(*) from shifts) = 0);
reset role;
set role anon;
select tst.err('anónimo no puede entrar', $q$select shift_start('111111')$q$, 'permission denied');
reset role;
select n, case when ok then 'OK ' else 'FALLA' end as r, name, case when ok then '' else info end from tst.res order by n;
