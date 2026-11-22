#!/usr/bin/env bash
# Writes .env with random passwords. Never overwrites an existing .env.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { echo ".env exists, leaving it alone"; exit 0; }
r() { openssl rand -hex 16; }
sed -e "s/^PGPASSWORD=.*/PGPASSWORD=$(r)/" -e "s/^MZ_APP_PASSWORD=.*/MZ_APP_PASSWORD=$(r)/" \
    -e "s/^MZ_WORKER_PASSWORD=.*/MZ_WORKER_PASSWORD=$(r)/" -e "s/^S3_SECRET_KEY=.*/S3_SECRET_KEY=$(r)/" \
    -e "s/^MZ_MEDIA_SECRET=.*/MZ_MEDIA_SECRET=$(r)$(r)/" .env.example > .env
chmod 600 .env
echo ".env written (git-ignored)"
set -a; . ./.env; set +a
echo
echo "Put these two lines in apps/web/.env.local (resolved, ready to paste):"
echo "DATABASE_URL=postgres://mz_app:${MZ_APP_PASSWORD}@localhost:5442/mezzala_gclub"
echo "DATABASE_URL_OWNER=postgres://mezzala:${PGPASSWORD}@localhost:5442/mezzala_gclub"
