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
-- PIN de soporte
reset role; set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$
declare ad text; sp text; sp2 text; r jsonb; pin1 text; pin2 text; n int;
begin
  select token into ad from shift_start('111111');
  perform tst.err('duración inválida rechazada', format($q$select support_pin_create(%L, 5)$q$, ad), 'Duración');
  r := support_pin_create(ad, 24);
  pin1 := r->>'pin';
  perform tst.chk('genera PIN de 6 dígitos', pin1 ~ '^\d{6}$', r::text);
  perform tst.chk('vence en 24 horas', (r->>'expires_at')::timestamptz between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute');
  select token into sp from shift_start(pin1);
  perform tst.chk('soporte entra con su PIN', sp like 'T:%');
  perform tst.chk('soporte entra como admin', (select role from shift_start(pin1)) = 'admin');
  perform tst.chk('soporte ve el informe de ventas', sales_report(sp, now() - interval '1 day', now() + interval '1 day') ? 'totals');
  perform tst.err('soporte no puede crear empleados', format($q$select staff_upsert(%L, null, 'X', '444444', 'admin', true)$q$, sp), 'soporte no puede');
  perform tst.err('soporte no genera otro PIN de soporte', format($q$select support_pin_create(%L, 24)$q$, sp), 'soporte no puede');
  perform tst.chk('soporte no ocupa lugar de admin', (select count(*) from staff_list(ad) where role = 'admin' and active and not is_support) = 2
    and (select count(*) from staff_list(ad) where is_support and active) = 1);
  perform tst.err('soporte no se edita como empleado', format($q$select staff_upsert(%L, %L, 'Soporte', null, 'admin', false)$q$, ad,
    (select id from staff_list(ad) where is_support and active)), 'aparte');
  r := support_pin_create(ad, 72);
  pin2 := r->>'pin';
  perform tst.chk('PIN nuevo anula al anterior', (select count(*) from shift_start(pin1)) = 0 and (select count(*) from staff_list(ad) where is_support and active) = 1);
  select token into sp2 from shift_start(pin2);
  perform support_pin_revoke(ad);
  perform tst.err('revocar corta el pase al momento', format($q$select cash_status(%L)$q$, sp2), 'Turno vencido');
  perform tst.chk('PIN revocado ya no entra', (select count(*) from shift_start(pin2)) = 0);
  r := support_pin_create(ad, 168);
  reset role; update employees set expires_at = now() - interval '1 minute' where is_support and active; set role authenticated;
  perform tst.chk('PIN vencido ya no entra', (select count(*) from shift_start(r->>'pin')) = 0);
  perform tst.chk('el admin del negocio sigue entrando', (select count(*) from shift_start('111111')) = 1);
end $$;
-- Cierre olvidado (caja de un día anterior)
reset role;
select tst.chk('día de operación: 11 pm y 1 am son el mismo día',
  biz_day('2026-10-24 23:00-06') = biz_day('2026-10-25 01:00-06') and biz_day('2026-10-25 06:00-06') > biz_day('2026-10-25 01:00-06'));
select tst.err('la app no llama biz_day', $q$set local role authenticated; select biz_day(now())$q$, 'permission denied');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$
declare ad text; r jsonb; ch int;
begin
  select token into ad from shift_start('111111');
  select id into ch from products where short_name = 'Chico';
  reset role; delete from cash_sessions where closed_at is null; set role authenticated;
  reset role;
  insert into cash_sessions(opened_by, opening_cents, opened_at) select id, 30000, now() - interval '30 hours' from employees where name = 'Dueño';
  set role authenticated;
  r := cash_status(ad);
  perform tst.chk('caja de ayer abierta queda pendiente', (r->>'open')::boolean and (r->>'stale')::boolean, r::text);
  perform tst.chk('la entrada avisa del cierre pendiente', ((select cash from shift_start('111111'))->>'stale')::boolean);
  perform tst.err('no se cobra con el cierre pendiente', format($q$select * from register_sale(%L, '[{"product_id":%s,"qty":1}]', 'card', null)$q$, ad, ch), 'Cierra la caja de ayer');
  r := cash_close(ad, 30000);
  perform tst.chk('se cierra la caja pendiente con el conteo', (r->>'open')::boolean = false and (r->>'counted_cents')::int = 30000, r::text);
  r := cash_status(ad);
  perform tst.chk('después del cierre pendiente se puede abrir la de hoy', (r->>'open')::boolean = false and (r->>'today_closed')::boolean = false, r::text);
  r := cash_open(ad, 0);
  perform tst.chk('caja de hoy no está pendiente', (cash_status(ad)->>'stale')::boolean = false);
  perform tst.chk('con la caja de hoy sí se cobra', (select count(*) from register_sale(ad, format('[{"product_id":%s,"qty":1}]', ch)::jsonb, 'card', null)) = 1);
end $$;
-- Notificaciones push
reset role; set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$
declare ad text;
begin
  select token into ad from shift_start('111111');
  perform tst.err('push sin pase rechazado', $q$select push_subscribe('T:nada', 'https://fcm.googleapis.com/x', repeat('a', 87), repeat('b', 22))$q$, 'Turno vencido');
  perform tst.err('push con dirección no https rechazado', format($q$select push_subscribe(%L, 'http://malo', %L, %L)$q$, ad, repeat('a', 87), repeat('b', 22)), 'no válida');
  perform push_subscribe(ad, 'https://fcm.googleapis.com/fcm/send/abc', repeat('a', 87), repeat('b', 22));
  perform push_subscribe(ad, 'https://fcm.googleapis.com/fcm/send/abc', repeat('c', 87), repeat('d', 22));
  perform tst.err('la caja no puede leer suscripciones', $q$select count(*) from push_subscriptions$q$, 'permission denied');
  perform tst.err('la caja no puede leer las llaves', $q$select vapid_private from push_config$q$, 'permission denied');
end $$;
reset role;
select tst.chk('registrar el mismo teléfono dos veces no duplica', (select count(*) from push_subscriptions) = 1 and (select p256dh from push_subscriptions) = repeat('c', 87));
select tst.chk('aviso programado a las 03:00 UTC (9 pm CDMX)', (select schedule from cron.job where jobname = 'aviso-cierre') = '0 3 * * *');
select tst.chk('secreto del cron generado', (select length(cron_secret) from push_config) = 48);
update push_config set fn_url = 'https://x.supabase.co/functions/v1/aviso-cierre';
delete from net.calls;
do $$ begin execute (select command from cron.job where jobname = 'aviso-cierre'); end $$;
select tst.chk('con la caja abierta, a las 9 pm llama a la función con el secreto',
  (select count(*) from net.calls) = 1 and (select headers->>'x-cron-secret' from net.calls) = (select cron_secret from push_config));
update cash_sessions set closed_at = now(), closed_by = opened_by, counted_cents = 0, expected_cents = 0 where closed_at is null;
delete from net.calls;
do $$ begin execute (select command from cron.job where jobname = 'aviso-cierre'); end $$;
select tst.chk('con la caja cerrada no manda nada', (select count(*) from net.calls) = 0);
set role anon;
select tst.err('anónimo no registra teléfonos', $q$select push_subscribe('111111', 'https://a', 'x', 'y')$q$, 'permission denied');
-- Cierre con cambio entregado
reset role; set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$
declare ad text; r jsonb; ch int;
begin
  select token into ad from shift_start('111111');
  select id into ch from products where short_name = 'Chico';
  reset role; delete from net.calls; update cash_sessions set closed_at = now(), closed_by = opened_by, counted_cents = 0, expected_cents = 0 where closed_at is null;
  delete from sale_items where sale_id in (select id from sales where session_id in (select id from cash_sessions where biz_day(opened_at) = biz_day(now())));
  update sales set session_id = null where session_id in (select id from cash_sessions where biz_day(opened_at) = biz_day(now()));
  delete from cash_sessions where biz_day(opened_at) = biz_day(now()); set role authenticated;
  perform cash_open(ad, 50000);
  perform register_sale(ad, format('[{"product_id":%s,"qty":2}]', ch)::jsonb, 'cash', 10000);   -- $70, paga con $100, cambio $30
  perform register_sale(ad, format('[{"product_id":%s,"qty":1}]', ch)::jsonb, 'cash', 3500);    -- $35 exacto
  perform register_sale(ad, format('[{"product_id":%s,"qty":1}]', ch)::jsonb, 'card', null);    -- tarjeta no entra al cajón
  r := cash_status(ad);
  perform tst.chk('cierre: efectivo recibido $135', (r->>'cash_received_cents')::int = 13500, r::text);
  perform tst.chk('cierre: cambio entregado $30', (r->>'change_cents')::int = 3000, r::text);
  perform tst.chk('cierre: esperado = $500 + $135 − $30 = $605', (r->>'expected_cents')::int = 60500, r::text);
  r := cash_close(ad, 60500);
  perform tst.chk('cierre cuadra exacto con el cambio', (r->>'counted_cents')::int - (r->>'expected_cents')::int = 0, r::text);
end $$;
-- Activación de teléfonos con código
reset role;
insert into auth.users(id) values ('00000000-0000-0000-0000-0000000000c3'), ('00000000-0000-0000-0000-0000000000c4'); -- usuarios anónimos
select tst.chk('código de arranque: 8 caracteres legibles', (select device_code_bootstrap('Caja 3')) ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$');
create temp table codes(c text); grant all on codes to authenticated;
insert into codes select device_code_bootstrap('Caja 3');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c3',false);
select tst.chk('teléfono nuevo no es caja', device_status() = false);
select tst.err('teléfono nuevo no puede entrar con PIN', $q$select shift_start('111111')$q$, 'Dispositivo no autorizado');
select tst.chk('código equivocado no activa', device_activate('ZZZZ-ZZZZ') = false);
select tst.chk('código bueno activa (minúsculas y sin guion también)', device_activate(lower(replace((select c from codes), '-', ''))) = true);
select tst.chk('teléfono activado ya es caja', device_status() = true);
select tst.chk('activado entra con PIN', (select count(*) from shift_start('111111')) = 1);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c4',false);
select tst.chk('el código no sirve dos veces', device_activate((select c from codes)) = false);
reset role; update device_codes set used_at = null, expires_at = now() - interval '1 minute'; set role authenticated;
select tst.chk('código vencido no activa', device_activate((select c from codes)) = false);
reset role; select tst.chk('fallos de activación se guardan', (select count(*) from device_code_attempts) = 3); set role authenticated;
do $$ begin for i in 1..30 loop begin perform device_activate('AAAA-AAA' || i); exception when others then exit; end; end loop; end $$;
select tst.err('muchos fallos bloquean la activación 15 min', $q$select device_activate('BBBB-BBBB')$q$, 'Demasiados intentos');
reset role; delete from device_code_attempts; set role authenticated;
-- el dueño genera códigos y quita teléfonos
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$
declare ad text; caj text; r jsonb; n int;
begin
  select token into ad from shift_start('111111');
  r := device_code_create(ad, 'Caja 4');
  perform tst.chk('el dueño genera código de 30 min', (r->>'code') ~ '^.{4}-.{4}$' and (r->>'expires_at')::timestamptz > now() + interval '29 minutes', r::text);
  perform tst.chk('lista de teléfonos marca este', (select count(*) from device_list(ad) where this_one) = 1 and (select count(*) from device_list(ad)) >= 3);
  perform tst.err('no puedes quitar tu propio teléfono', format($q$select device_remove(%L, '00000000-0000-0000-0000-00000000000a')$q$, ad), 'estás usando');
  perform device_remove(ad, '00000000-0000-0000-0000-0000000000c3');
  perform tst.chk('teléfono quitado sale de la lista', (select count(*) from device_list(ad) where user_id = '00000000-0000-0000-0000-0000000000c3') = 0);
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c3',false);
select tst.err('teléfono quitado ya no entra', $q$select shift_start('111111')$q$, 'Dispositivo no autorizado');
select tst.err('la app no puede crear códigos sin PIN de admin', $q$select device_code_bootstrap('x')$q$, 'permission denied');
reset role;
select n, case when ok then 'OK ' else 'FALLA' end as r, name, case when ok then '' else info end from tst.res order by n;
