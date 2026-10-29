#!/bin/sh
# Corre todas las migraciones en una base local nueva y luego la prueba de punta a punta.
# No toca Supabase. Uso: PGHOST=... PGPORT=... sh supabase/tests/run.sh
D=$(cd "$(dirname "$0")/.." && pwd)
DB=${DB:-pancho_test}
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null || exit 1
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/tests/stub.sql" >/dev/null || exit 1
T=$(mktemp -d)
for f in "$D"/migrations/0*.sql; do
  # pg_cron y pg_net no existen en un Postgres local: stub.sql los imita
  grep -vE "create extension if not exists (pg_cron|pg_net)" "$f" > "$T/$(basename "$f")"
  psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/$(basename "$f")" >/dev/null 2>&1 || { echo "Falló la migración $f"; psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/$(basename "$f")" 2>&1 | grep ERROR; exit 1; }
done
# permisos directos cerrados, como en el servidor real
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/../db/hardening.sql" >/dev/null 2>&1 || { echo "Falló hardening.sql"; exit 1; }
out=$(psql -q -d "$DB" -f "$D/tests/e2e.sql" 2>&1)
echo "$out" | grep -E "ERROR|^ *[0-9]+ \|"
if echo "$out" | grep -qE "ERROR|FALLA"; then echo "HAY FALLAS"; exit 1; fi
echo "Todo OK"
