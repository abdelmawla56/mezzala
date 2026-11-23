# Prompt for Antigravity: backend + integration with `infra/`

Paste everything below the line into Antigravity. Start it in **planning mode** and approve the plan before it edits code.

---

## Role and goal

You are the backend engineer on MEZZALA's native tagging system (Next.js 16 / React 19 / TypeScript, `pg`, Postgres 16, repo layout `apps/web`, `services/pipeline`, `packages/*`, `infra/`). The infrastructure package in `infra/` is already built and tested. Your job is to **integrate the existing backend with it**, in the order below, and nothing else. Do not start RAG or LLM work. Do not rewrite the app.

Read first, in this order: `infra/README.md`, `infra/db/migrations/*.sql`, `infra/contracts/with-tenant.ts`, `infra/worker/mz_worker/jobs.py`, then `apps/web/lib/db.ts`, `lib/tagging/store.ts`, `lib/tg/core.ts`, `lib/tg/storage.ts`, `app/api/media/route.ts`, `app/api/tagging/route.ts`, `app/api/qa/route.ts`, `scripts/*-check.mjs`.

## Ground rules

1. **Do not edit `infra/`.** If it needs a change, stop and write the request (what, why, which file) in `docs/infra-requests.md`. Exception: a new numbered migration file you add under `infra/db/migrations/` (never edit 0001 to 0006 after they are applied).
2. **Never touch founder decisions.** Open items (D-01..D-31, F-01..F-08, DEC-017, the media ADR, vendor choice) are not yours to settle. No real AWS resources, no real AI vendor. Local MinIO only.
3. **Product rules stay intact:** revisions are immutable (a correction is a new revision); every write is audited; playback URLs live 10 minutes or less; no public share links; errors stay bilingual (EN/AR); AI proposes but never computes or chooses a number; no LLM text on minors. Do not change any behaviour these rules cover.
4. **No secrets in git or in chat.** `.env`, `.env.local`, `seed-accounts.local.md`, `media-local/`, `data/bundle.json` stay ignored. Never print a password or presigned URL in logs.
5. One branch and one commit series per task below. Small commits. Never force-push. Show diffs; do not bulk-reformat files.
6. When something in the code contradicts this prompt, **stop and ask**; do not guess. Name the file and line.

## What `infra/` gives you (the contract)

- **Three database URLs.** `DATABASE_URL` = role `mz_app` (runtime: no DDL, no TRUNCATE, no UPDATE/DELETE on append-only tables, subject to RLS). `DATABASE_URL_OWNER` = migrations, seeding and test cleanup only. The worker uses its own role.
- **Tenant context.** Tenant tables have forced row-level security on `club_id = mz_club()`. `mz_club()` reads `app.club_id`, set per transaction by `withTenant(pool, clubId, fn)` (`infra/contracts/with-tenant.ts`). Outside `withTenant` every tenant table returns zero rows. Child tables get `club_id` from their parent on INSERT, so existing INSERTs still work.
- **Introspection.** `SELECT * FROM mz_rls_report` lists every table as `ok`, `exempt` (with a reason) or `UNTENANTED`. `mz_tenant_tables` and `mz_rls_exempt` are the config; change them only via a new migration that ends with `SELECT mz_apply_tenant_rls(); SELECT mz_harden_privileges();`.
- **Object storage.** S3 API at `S3_ENDPOINT_URL` (MinIO), private bucket `S3_BUCKET`, path-style. Keys: originals `<club_id>/<match_id>/<asset_id>/original<ext>`; the worker writes only under `<club_id>/derived/<asset_ref>/`.
- **Job queue.** Insert into `media_job` (as `mz_app`, inside `withTenant`): `club_id`, `kind` in `probe|hash|proxy|thumbnails`, `asset_ref` (= media_asset id as text), `payload` (`{"key": "<object key>"}` required; `hash` also takes `expected_sha256`, `proxy` takes optional `height`, `thumbnails` takes optional `interval_s` and `duration_ms`), `idempotency_key` (unique per club). Poll `media_job.status` (`queued|running|succeeded|failed|cancelled`), read `result` and `last_error`. Worker output rows are in `media_derivative` (read-only for you): `proxy` and `thumbnail` kinds with `storage_key`, `bytes`, `sha256`, `meta`.
- Result shapes: probe `{duration_ms,width,height,fps,video_codec,audio_codec,bit_rate,size_bytes,container,keyframe_max_gap_s,keyframe_samples}`; hash `{sha256,bytes,matches_expected}`; proxy `{proxy_key,keyframe_max_gap_s,height}`; thumbnails `{count,interval_s}`.
- The worker **never writes `media_asset`**. Mapping results onto `media_asset` columns is your job (task 3).

## Tasks (do in order; stop after each for review)

### Task 0: orient and baseline (no app code changes)

`cd infra && make env && make baseline && make up`. Then `make rls-report` and read any WARNING from the migration output. Report: which tables are `UNTENANTED`, which config rows had no resolvable FK, orphan-row warnings. Fix by adding `0007_tenant_config.sql` (rows in `mz_tenant_tables` with explicit `fk_column`, or entries in `mz_rls_exempt` with a reason), then `SELECT mz_apply_tenant_rls()`. Acceptance: zero `UNTENANTED` rows. Also commit the working tree under version control (TG-ENG-01) if it is still uncommitted, with the ignore rules checked by `git check-ignore`.

### Task 1: connection layer and tenant enforcement (T1..T3, G5, G7)

- `lib/db.ts`: runtime pool from `DATABASE_URL` (pool size configurable, default 10). Add `lib/db-owner.ts` (owner URL) used **only** by scripts, never imported from `app/` or `lib/` request paths.
- Add `lib/db/with-tenant.ts` from the contract. Route every query that touches a tenant table through `withTenant(pool, tenantFor(user, requested), ...)`. Keep the existing `club_id = $n` filters (defence in depth); RLS must be the thing that would still hold if one were deleted.
- `ensureSeed()` must leave the request path. Create `scripts/db-seed.mjs` (owner URL, same advisory lock) and run it from `npm run db:setup`. `db:setup` applies migrations with dbmate (owner URL) instead of running `schema.sql` directly; seeded accounts and `seed-accounts.local.md` behave as today.
- Check scripts and cleanup: fixtures are created through the API as today, but **cleanup uses the owner URL** (the app role can no longer do `session_replication_role = replica`). Direct `sessions` inserts in the check scripts stay (sessions is exempt) but must use the owner URL.
- Acceptance: `tagging-check.mjs`, `qa-ai-check.mjs`, `video-check.mjs`, `api-check.mjs` all pass against `mz_app`. New `scripts/tenant-leak-check.mjs`: with two seeded tenants, every GET route in `/api/tagging`, `/api/qa`, `/api/media`, `/api/ai-tagging`, `/api/playlists` returns no TEST-000 row for a GCLUB user, **and** a raw query run inside `withTenant('GCLUB')` with no `club_id` filter on each tenant table returns no TEST-000 row. Another test proves the app role gets `permission denied` on UPDATE/DELETE/TRUNCATE for every append-only table (list them from `pg_trigger` where the function is `mz_append_only`).

### Task 2: S3 storage adapter and direct upload (G8, T4, T5, TAG-NFR-06)

- Implement the S3 adapter behind the existing storage interface in `lib/tg/storage.ts` with `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. `MZ_STORAGE=s3|local` selects it; the local adapter stays for offline dev. `forcePathStyle` when `S3_ENDPOINT_URL` is set.
- Upload flow (replaces streaming 20 GB through Node): `start` creates a multipart upload and returns presigned part URLs; the browser PUTs parts directly (it needs the `ETag` header, already exposed by CORS); `status` lists uploaded parts so an upload resumes after a tab kill; `finish` completes the multipart, HEADs the object and checks the size, then enqueues jobs (task 3). The rights gate (no upload without an active rights record) is unchanged and runs first.
- Playback: presigned GET, **600 seconds maximum**, issued only after a tenant and role check on the asset (closes T4). Prefer the proxy derivative when one exists, else the original. In s3 mode the per-process HMAC key (T5) is not used.
- Client (`client/tagging.js`, `client/video.js`): replace the whole-file `file.arrayBuffer()` SHA-256 with the worker `hash` job (the client may send an expected hash only if it can compute it in streaming chunks). Keep IndexedDB draft recovery untouched.
- Acceptance: a 1 GB test file uploads, survives killing the tab mid-upload and resumes, plays through a presigned URL that returns 403 after 10 minutes, and a GCLUB user cannot obtain a URL for a TEST-000 asset.

### Task 3: job ingestion into `media_asset` (G8)

- `lib/media/jobs.ts`: `enqueue(...)` with idempotency keys `finish:<asset>:<kind>`; a status read for the UI.
- Apply results idempotently when the job status is read (no cron): `hash.matches_expected === false` marks the upload failed and writes an audit row; probe values go to the existing probe columns on `media_asset`; `sha256` is stored when it was missing; a succeeded `proxy` makes the proxy the playback source. Map to the **real** column names; if a column does not exist, stop and ask rather than inventing one.
- Surface job state in the media UI minimally (queued / running / failed with the bilingual reason). No new screens.
- Acceptance: upload, wait, `media_asset` has duration and sha256, playback uses the proxy, and `keyframe_max_gap_s` on the proxy is 1.2 or less. Re-reading status twice applies results once (idempotent). A failed job shows a retry control that inserts a new job with a new idempotency key.

### Task 4: security and performance items already specified in the pack (§6.4, §6.5, TG-ENG-07)

- Login rate limiting and lockout (`app/api/auth/login/route.ts`); `Content-Type: application/json` enforced and an `Origin` check on mutating routes (no CSRF token needed if the Origin check is strict; justify in the PR).
- With the new indexes in place, run `EXPLAIN (ANALYZE, BUFFERS)` on `annotationsOf` and on `v_annotation_current` filtered by `match_id`, `pass_id` and `media_asset_id` against 5,000 seeded revisions. Record before/after numbers in the PR. Target p95 under 100 ms locally. If the view does not push filters down, propose the fix; do not change view semantics without asking.
- Acceptance: tests for each of the above; numbers in the PR description.

### Task 5: tests and CI wiring (TG-ENG-03)

Add Vitest and `npm test` (under 10 s) with table-driven tests for `derive`, every refusal branch of `checkOpenPass` / `checkPassWrite`, and `taxonomy.validate`. Add an `infra` job reference to the existing CI so `make test` and `mz_rls_report` run on every PR. Do not weaken or delete the existing check scripts.

## Phase 2 (do not start until Phase 1 is merged and I say so)

TG-ENG-09 (orientation transform as a pure versioned module with a server-side cross-check), TG-ENG-10 (split `store.ts`), G10 (annotation export), analysis run off the HTTP request, AI runs that advance without a browser polling. The last two need new worker job kinds: write them up in `docs/infra-requests.md`, do not implement.

## Out of scope

RAG, LLM features, the AI vendor adapter, Terraform and AWS, hosting decisions, new screens, taxonomy changes, anything marked PROPOSAL or UNSIGNED in the pack.

## How to report

After each task: what changed (files), how you verified (commands and results), anything you could not verify, and open questions. Say "not run" when you did not run something. Do not claim a check passed that you did not execute.
