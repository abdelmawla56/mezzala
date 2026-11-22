# MEZZALA infra

Drop this folder into the repo as `infra/` (next to `apps/`, `services/`).

```
infra/
  docker-compose.yml     Postgres 16, MinIO (S3 stand-in), dbmate migrate, media worker
  Makefile               env, baseline, up, migrate, rollback, rls-report, test
  db/migrations/         0001 baseline (placeholder) .. 0006; dbmate format, each with a down
  scripts/               create-roles.sh (mz_app, mz_worker), gen-env.sh
  worker/                Python media worker: SKIP LOCKED queue, ffprobe, sha256, MP4 proxy, thumbnails
  storage/               MinIO bucket init
  terraform/             AWS eu-central-1 bucket, per-tenant KMS, IAM policies, alarms (DO NOT APPLY YET)
  contracts/             with-tenant.ts: the one function every tenant query goes through
  tests/                 DB + worker integration tests (pytest)
  ANTIGRAVITY_PROMPT.md  the backend + integration brief
```

## Start

```bash
cd infra
make env          # .env with random passwords, prints the two URLs for apps/web/.env.local
make baseline     # copies apps/web/db/schema.sql into migration 0001 (run once)
make up           # db + minio + bucket, migrations, worker
make rls-report   # every table: ok / exempt (reason) / UNTENANTED
```

An existing `gclub-pg` volume will not re-run the init script: use `make roles` once, then `make migrate`.
Stop the old `mezzala-gclub-pg` container first (same port 5442).

## What each piece closes (gap ids from the pack)

| Gap | Piece |
|---|---|
| G5 row-level security, T1..T3 | 0002 helpers + 0005 `mz_apply_tenant_rls()`, forced policies on `club_id = mz_club()` |
| G6 numbered migrations | dbmate, 0001..0006, all reversible (tested: rollback x5 then up) |
| G7 append-only as a grant | 0006: app role loses UPDATE/DELETE/TRUNCATE on every table carrying `mz_append_only()`; list derived from the triggers |
| G8 media worker | 0003 `media_job` / `media_derivative` + `worker/` (probe, hash, 1 s keyframe MP4 proxy, thumbnails) |
| G18 observability | worker JSON logs + CloudWatch EMF metric `QueueLagSeconds`; Terraform alarms |
| TG-ENG-07 indexes | 0004 |
| T4, T5 media URLs | storage keys under `<club>/`, worker enforces prefix; app-side presigning is task 2 of the prompt |

## Verified here, and not

Verified (Postgres 16.15, ffmpeg, dbmate 2.38.1, moto S3, node-postgres): 17 DB tests (tenant isolation both directions, unset tenant sees nothing,
cross-tenant insert refused, backfill of club_id on child tables, append-only by grant, no TRUNCATE/DDL/trigger bypass, role flags, worker boundaries,
rollback and reapply), 6 worker unit tests, 6 worker integration tests (probe, hash match, proxy keyframe gap <= 1.2 s, thumbnails, tenant-prefix escape fails permanently,
retry with backoff then fail, dead-worker lease reaped, cancelled job not resurrected), and `withTenant` over a reused pooled connection.

**Not verified:**
- `docker compose` itself (no Docker where this was built): the compose file parses as YAML; images, the MinIO CORS env var, `mc` commands and the worker Dockerfile are unrun.
- **The real `schema.sql`.** The pack describes tables and columns but does not contain the file. Tests run against `tests/fixture_schema.sql`, a stand-in using the pack's names. Migrations 0004 (index columns) and 0005 (parent/FK guesses) may need a follow-up migration on the real schema; `mz_rls_report` and the CI step tell you exactly where. Assumes `tenant.id` is text and tenant columns are called `club_id`.
- Terraform: HCL parses; no `validate`, `plan` or `apply`.
- The GitHub Actions workflow has not run.

## Assumptions to confirm

- The owner role is the Postgres superuser in dev. In RDS use the master user; the `mz_owner` policy keeps it working under FORCE.
- Legacy tables (`users`, `sessions`, `audit_log`, ...) are exempt from RLS with a written reason; a second real club needs tenant membership on users (risk T3). That is a schema and auth change, not infra.
- Worker proxy: H.264 + AAC, 720p cap, keyframe every 1 s. Both are env settings; the pack names the short-keyframe proxy but not the numbers.
- Hosting stays unsigned (DEC-017 and the media ADR). Nothing here talks to AWS unless you apply `terraform/`.
