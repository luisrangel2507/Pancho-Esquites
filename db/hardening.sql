-- Cierra permisos directos: la app solo entra por las funciones de la base (que validan PIN y rol).
-- La única lectura directa permitida es el menú. Se ejecuta en cada arranque, después de las migraciones.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
grant select on categories, products to authenticated;
