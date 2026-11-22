SHELL := /bin/bash
-include .env
export
DC := docker compose

.PHONY: env baseline up down reset roles migrate rollback status psql test test-db test-worker rls-report

env:        ## write .env with random passwords
	./scripts/gen-env.sh
baseline:   ## adopt the existing schema as migration 0001 (run once, from the repo with apps/web)
	@test -f ../apps/web/db/schema.sql || (echo "expected ../apps/web/db/schema.sql (put this folder at <repo>/infra)"; exit 1)
	@printf -- '-- migrate:up\n' > db/migrations/0001_baseline.sql
	@cat ../apps/web/db/schema.sql >> db/migrations/0001_baseline.sql
	@printf '\n-- migrate:down\nSELECT 1;\n' >> db/migrations/0001_baseline.sql
	@echo "0001_baseline.sql written from apps/web/db/schema.sql"
up:         ## db + minio + bucket, then migrate, then worker
	$(DC) up -d db minio minio-init
	$(DC) run --rm migrate up
	$(DC) up -d --build worker
down:
	$(DC) down
reset:      ## DESTROYS local data: fresh volumes, roles, migrations
	$(DC) down -v
	$(MAKE) up
roles:      ## existing Postgres volume (init scripts do not re-run): create roles by hand
	$(DC) exec -T db env POSTGRES_USER=mezzala POSTGRES_DB=mezzala_gclub \
	  MZ_APP_PASSWORD=$$MZ_APP_PASSWORD MZ_WORKER_PASSWORD=$$MZ_WORKER_PASSWORD bash -s < scripts/create-roles.sh
migrate:
	$(DC) run --rm migrate up
rollback:
	$(DC) run --rm migrate rollback
status:
	$(DC) run --rm migrate status
psql:       ## owner shell
	$(DC) exec db psql -U mezzala mezzala_gclub
rls-report: ## anything UNTENANTED must be fixed or exempted with a reason
	$(DC) exec -T db psql -U mezzala mezzala_gclub -c "SELECT * FROM mz_rls_report ORDER BY status DESC, table_name"
test: test-db test-worker
test-db:    ## needs a local Postgres + dbmate on PATH; see tests/conftest.py for env
	cd tests && python3 -m pytest -q
test-worker:
	cd worker && python3 -m pytest -q tests
