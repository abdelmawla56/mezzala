#!/usr/bin/env bash
set -euo pipefail

INFRA="/mnt/c/Users/YOUSSEF/Desktop/clip/mezzala/infra"
cd "$INFRA"

echo "=== Ensuring schema_migrations table exists ==="
docker exec -i mezzala-pg psql -v ON_ERROR_STOP=1 -U mezzala mezzala_gclub -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version varchar(128) PRIMARY KEY
  );
"

for f in $(ls db/migrations/*.sql | sort); do
  fname=$(basename "$f")
  # dbmate version is the numeric prefix
  ver=$(echo "$fname" | cut -d'_' -f1)
  
  # check if already applied
  applied=$(docker exec -i mezzala-pg psql -U mezzala -d mezzala_gclub -tAc "SELECT 1 FROM schema_migrations WHERE version = '$ver'")
  if [ "$applied" = "1" ]; then
    echo "Migration $fname ($ver) already applied, skipping."
    continue
  fi
  
  echo "Applying $fname ($ver)..."
  # Extract the up portion (between '-- migrate:up' and '-- migrate:down')
  sql=$(awk '/-- migrate:down/{exit} /-- migrate:up/{flag=1; next} flag{print}' "$f")
  
  # Execute inside a transaction
  (
    echo "BEGIN;"
    echo "$sql"
    echo "INSERT INTO schema_migrations (version) VALUES ('$ver');"
    echo "COMMIT;"
  ) | docker exec -i mezzala-pg psql -v ON_ERROR_STOP=1 -U mezzala mezzala_gclub
  echo "Successfully applied $fname."
done

echo "=== All migrations applied ==="
