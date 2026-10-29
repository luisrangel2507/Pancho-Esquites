# Pancho Esquites POS

Caja registradora para celular (app instalable). **Todo vive en Railway**: la app, el servidor y la base de datos Postgres. Costo base: el uso de Railway.

## Cómo está armado
- **App** (Next.js exportado a archivos estáticos, carpeta `app/`). Se instala en el celular y no lleva ninguna contraseña.
- **Servidor** (`server/`, Node): sirve la app, da a cada teléfono una sesión firmada y deja llamar a las funciones de la base. Manda el aviso de cierre de las 9 pm.
- **Base de datos** (Postgres): todas las reglas viven en funciones SQL (`supabase/migrations/` y `db/`): precios, PIN, caja, permisos. El navegador no puede leer ni escribir tablas directo; solo llama funciones, y cada función valida el PIN y el rol.

## Publicar en Railway (una vez)
1. Railway → **New Project** → **Deploy from GitHub repo** → este repo y la rama.
2. En el mismo proyecto: **New** → **Database** → **PostgreSQL**.
3. Servicio de la app → **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (referencia a la base)
   - `BOOTSTRAP_ADMIN_PIN` = 6 números para el administrador del primer arranque
4. Servicio de la app → **Settings → Networking → Generate Domain**.
5. Primer arranque: el servidor crea las tablas y el menú, crea al administrador "Dueño" y escribe en los **Logs** un **código para activar el primer teléfono**. Abre la dirección en el celular, escribe el código y entra con el PIN.
6. Borra la variable `BOOTSTRAP_ADMIN_PIN` (ya no hace falta).

Más teléfonos: Menú → **Teléfonos** → Activar otro teléfono (código de un solo uso, dura 30 min). Si se pierden todos: reinicia el servicio y el código nuevo aparece en los Logs.

## Seguridad
- Cada teléfono es una sesión anónima firmada por el servidor; sin activar con código no puede ni intentar un PIN.
- PIN de 6 dígitos; 5 intentos fallidos bloquean 5 minutos ese teléfono. El PIN se guarda solo como hash (bcrypt).
- El rol de la app no tiene permiso sobre las tablas (solo lee el menú): `db/hardening.sql` lo vuelve a cerrar en cada arranque.
- Sesión del empleado: se cierra a las 3 horas sin uso. PIN de soporte temporal para el desarrollador (24 h, 3 o 7 días, revocable).
- El repo debe ser **privado**. Cambia el PIN de cada empleado al entregar.

## Aviso de cierre (9 pm)
El servidor revisa cada día a las 03:00 UTC (9 pm de Ciudad de México): si la caja sigue abierta, manda una notificación push a los teléfonos que aceptaron avisos. En iPhone solo funciona con la app agregada a la pantalla de inicio (iOS 16.4+).

## Respaldo
`.github/workflows/backup.yml` respalda la base cada noche, cifrada, y la guarda 30 días.
- GitHub → Settings → Secrets → Actions: `BACKUP_DB_URL` = Railway → Postgres → Variables → `DATABASE_PUBLIC_URL`, y `BACKUP_PASSPHRASE` = frase de 12+ caracteres (guárdala aparte).
- Probar: Actions → backup → Run workflow.
- **Restaurar:** `gpg -d pancho-AAAA-MM-DD.sql.gz.gpg | gunzip > respaldo.sql`, luego
  `psql "<DATABASE_PUBLIC_URL>" -c "drop schema public cascade; create schema public;"` y `psql "<DATABASE_PUBLIC_URL>" -f respaldo.sql`; después reinicia el servicio (reaplica permisos y escribe un código para activar teléfonos).

## Pruebas
- Base de datos (necesita Postgres local): `PGHOST=... PGPORT=... sh supabase/tests/run.sh`
- Servidor de punta a punta: arrancar con una base vacía y correr `node server/e2e.mjs http://127.0.0.1:3000 <código del primer teléfono> <BOOTSTRAP_ADMIN_PIN>`

## Desarrollo
`npm run build` genera `out/`; `npm start` levanta el servidor (necesita `DATABASE_URL`). La carpeta `supabase/` conserva ese nombre por historia: solo contiene el SQL y sus pruebas.
