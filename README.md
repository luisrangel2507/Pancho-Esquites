# Pancho Esquites POS

Next.js (exportación estática) en **Cloudflare Pages** + **Supabase** (Postgres, Auth, Storage).
Respaldo nocturno cifrado en **GitHub Actions**. Costo base: $0/mes.

## Modelo de seguridad

| Si roban… | Qué obtienen | Por qué no es grave |
|---|---|---|
| Cloudflare (hosting) | Archivos estáticos y la anon key | La anon key sin sesión no puede leer ni ejecutar nada (RLS + `revoke ... from anon`). |
| Sesión de una caja | Ver menú y registrar ventas con PIN válido | No ve ventas, empleados ni inventario. 5 intentos de PIN cada 5 min. |
| PIN de un cajero | Cobrar como ese empleado | No puede anular, ni ver reportes. Lo desactivas desde Admin. |
| La base de datos | PINs con hash bcrypt, ventas | No hay tarjetas ni datos personales de clientes. |
| Cuenta admin | Necesitan contraseña **y** código 2FA | `is_admin()` exige nivel `aal2`. |

Reglas:
- **Nunca** subas la `service_role` key a Cloudflare, GitHub ni al código. Este proyecto no la usa.
- Precios y totales se calculan en la base (`register_sale`), no en el navegador.
- 2FA con app autenticadora en GitHub, Cloudflare, Supabase y tu correo.
- Llaves distintas por cliente/proyecto.

## Puesta en marcha

1. **Supabase** → proyecto nuevo (región `us-east` o la más cercana).
   - SQL Editor: correr `supabase/migrations/0001_init.sql` y luego `0002_seed.sql`.
   - Authentication → Providers: desactivar "Allow new users to sign up".
   - Authentication → MFA: activar TOTP.
   - Storage: bucket público `products` (solo lectura pública; subir solo admin).
2. **Usuarios** (Authentication → Users → Add user):
   - `caja@tudominio` → `insert into devices(user_id,label) values ('<uuid>','Caja 1');`
   - Dueño → `insert into admins(user_id) values ('<uuid>');` y en su primer login configurar 2FA.
   - Primer empleado admin con PIN (desde SQL, una sola vez):
     `insert into employees(name,pin_hash,role) values ('Dueño', crypt('<pin>', gen_salt('bf',10)), 'admin');`
3. **GitHub** → repo privado, rama `main` protegida.
4. **Cloudflare Pages** → conectar repo · build `npm run build` · salida `out` ·
   variables `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
5. **Respaldo**:
   - `age-keygen -o pancho.key` en tu compu → guarda `pancho.key` en tu gestor de contraseñas.
   - En Supabase: `create role backup_ro login password '<fuerte>'; grant pg_read_all_data to backup_ro;`
   - GitHub Secrets: `BACKUP_DB_URL` (con `backup_ro`) y `AGE_PUBLIC_KEY`.
   - Restaurar: `age -d -i pancho.key pancho-AAAA-MM-DD.sql.gz.age | gunzip | psql <url>`

## Si un proveedor reporta un incidente
1. Supabase → Settings → API → **rotar JWT secret** (invalida anon key y sesiones). Actualiza la variable en Cloudflare.
2. Cambiar contraseña de `backup_ro` y el secret en GitHub.
3. Cambiar contraseñas de `caja@` y admins; reactivar cajas.
4. Revisar `sales` e `inventory_moves` de las últimas horas.
