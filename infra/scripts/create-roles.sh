#!/usr/bin/env bash
# Creates / refreshes the two least-privilege runtime roles. Idempotent.
#   mz_app    : the web app. NOSUPERUSER, NOBYPASSRLS, not an owner, no DDL.
#   mz_worker : the media worker. Only touches media_job / media_derivative (see migration 0006).
# Usage: MZ_APP_PASSWORD=.. MZ_WORKER_PASSWORD=.. create-roles.sh [dbname]
# Also mounted as /docker-entrypoint-initdb.d/01-roles.sh (runs once on an empty volume).
set -euo pipefail
: "${MZ_APP_PASSWORD:?set MZ_APP_PASSWORD}"
: "${MZ_WORKER_PASSWORD:?set MZ_WORKER_PASSWORD}"
DB="${1:-${POSTGRES_DB:-mezzala_gclub}}"
[ -n "${POSTGRES_USER:-}" ] && export PGUSER="$POSTGRES_USER"

psql -v ON_ERROR_STOP=1 --no-psqlrc -d "$DB" \
  -v db="$DB" -v app_pw="$MZ_APP_PASSWORD" -v worker_pw="$MZ_WORKER_PASSWORD" <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mz_app')    AS mk_app    \gset
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mz_worker') AS mk_worker \gset
\if :mk_app
  CREATE ROLE mz_app LOGIN;
\endif
\if :mk_worker
  CREATE ROLE mz_worker LOGIN;
\endif
ALTER ROLE mz_app    WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_pw';
ALTER ROLE mz_worker WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'worker_pw';
GRANT CONNECT ON DATABASE :"db" TO mz_app, mz_worker;
SQL
echo "roles ready on $DB"
