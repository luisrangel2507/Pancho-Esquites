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
| Cuenta admin | Necesitan correo y contraseña del admin | Usa una contraseña larga y única solo para esto. |

Reglas:
- **Nunca** subas la `service_role` key a Cloudflare, GitHub ni al código. Este proyecto no la usa.
- Precios y totales se calculan en la base (`register_sale`), no en el navegador.
- 2FA con app autenticadora en GitHub, Cloudflare, Supabase y tu correo.
- Llaves distintas por cliente/proyecto.

## Puesta en marcha

1. **Supabase** → proyecto nuevo (región `us-east` o la más cercana).
   - SQL Editor: correr `supabase/migrations/0001_init.sql` y luego `0002_seed.sql`.
   - Authentication → Providers: desactivar "Allow new users to sign up".
   - Storage: bucket público `products` (solo lectura pública; subir solo admin).
2. **Teléfonos y empleados**:
   - Authentication → Sign In / Providers: activar **Allow anonymous sign-ins** (cada teléfono tiene su propia sesión; la app no lleva contraseñas).
   - Correr `supabase/pegar_todo.sql` y, para el primer teléfono, `select device_code_bootstrap('Caja 1');` → escribir ese código en la pantalla "Activar teléfono".
   - Los demás teléfonos se activan desde la app: Menú → Teléfonos → Activar otro teléfono (código de un uso, dura 30 min).
   - Primer empleado admin con PIN (desde SQL, una sola vez):
     `insert into employees(name,pin_hash,role) values ('Dueño', crypt('<pin de 6 dígitos>', gen_salt('bf',8)), 'admin');`
3. **GitHub** → repo privado, rama `main` protegida.
4. **Cloudflare (Workers/Pages)** → conectar repo · build `npm run build` · deploy `npx wrangler deploy` (usa `wrangler.jsonc`, salida `out`) ·
   variables `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
5. **Respaldo** (nocturno, cifrado, en GitHub Actions; ver `.github/workflows/backup.yml`):
   - GitHub → Settings → Secrets and variables → Actions:
     `BACKUP_DB_URL` = Supabase → Connect → **Session pooler** (con la contraseña de la base) y
     `BACKUP_PASSPHRASE` = una frase secreta de 12+ caracteres, guardada también fuera de GitHub.
   - Probar: Actions → backup → Run workflow. Restaurar: ver el encabezado del archivo del workflow.

## Si un proveedor reporta un incidente
1. Supabase → Settings → API → **rotar JWT secret** (invalida anon key y sesiones). Actualiza la variable en Cloudflare.
2. Cambiar contraseña de `backup_ro` y el secret en GitHub.
3. Cambiar contraseñas de `caja@` y admins; reactivar cajas.
4. Revisar `sales` e `inventory_moves` de las últimas horas.

## Aviso de cierre de caja (notificaciones push)
1. Correr `supabase/pegar_todo.sql` (crea la tabla de teléfonos, el secreto y el aviso diario a las 03:00 UTC = 9 pm CDMX).
2. Supabase → Edge Functions → nueva función **`aviso-cierre`** con el código de `supabase/functions/aviso-cierre/index.ts` → Deploy.
   En su configuración, **apagar "Enforce JWT verification"** (el cron no manda sesión; la función se protege con el secreto de `push_config`).
3. En cada teléfono: menú → "Activar avisos de cierre" (o al abrir la caja) y permitir. En iPhone solo funciona con la app agregada a la pantalla de inicio (iOS 16.4+).
4. Probar ya (con la caja abierta): en SQL Editor
   `select net.http_post(url := fn_url, headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',cron_secret), body := '{}'::jsonb) from push_config;`
   `fn_url` se llena solo la primera vez que un teléfono activa los avisos.
