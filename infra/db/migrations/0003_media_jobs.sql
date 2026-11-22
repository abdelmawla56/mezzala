-- migrate:up
-- Queue for the media worker (TG-REQ: probe, hash, short-keyframe MP4 proxy, thumbnails).
-- Postgres SKIP LOCKED queue, no broker (16 §9.5). asset_ref is the media_asset id as text:
-- the worker never reads media_asset, the payload is self-contained.
CREATE TABLE media_job (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  club_id         text NOT NULL REFERENCES tenant(id),
  kind            text NOT NULL CHECK (kind IN ('probe','hash','proxy','thumbnails')),
  asset_ref       text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 3,
  run_after       timestamptz NOT NULL DEFAULT now(),
  locked_by       text,
  heartbeat_at    timestamptz,
  last_error      text,
  result          jsonb,
  idempotency_key text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE UNIQUE INDEX media_job_idem  ON media_job (club_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX media_job_claim        ON media_job (run_after, id) WHERE status = 'queued';
CREATE INDEX media_job_lease        ON media_job (heartbeat_at) WHERE status = 'running';
CREATE INDEX media_job_asset        ON media_job (club_id, asset_ref, id DESC);

-- What the worker produced. Written by the worker only; the app reads it.
CREATE TABLE media_derivative (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  club_id     text NOT NULL REFERENCES tenant(id),
  job_id      bigint NOT NULL REFERENCES media_job(id),
  asset_ref   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('proxy','thumbnail')),
  storage_key text NOT NULL,
  bytes       bigint,
  sha256      text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, storage_key)
);
CREATE INDEX media_derivative_asset ON media_derivative (club_id, asset_ref, kind);

-- Queue health for alarms and the ops screen.
CREATE VIEW v_media_queue_stats AS
SELECT club_id,
       count(*) FILTER (WHERE status = 'queued')  AS queued,
       count(*) FILTER (WHERE status = 'running') AS running,
       count(*) FILTER (WHERE status = 'failed')  AS failed,
       coalesce(extract(epoch FROM now() - min(run_after) FILTER (WHERE status = 'queued' AND run_after <= now())), 0)::int AS queue_lag_s
FROM media_job GROUP BY club_id;

DO $$ BEGIN
  IF to_regproc('mz_append_only') IS NOT NULL THEN
    EXECUTE 'CREATE TRIGGER mz_append_only_media_derivative BEFORE UPDATE OR DELETE ON media_derivative
             FOR EACH ROW EXECUTE FUNCTION mz_append_only()';
  END IF;
END $$;

-- RLS: the app sees only its tenant; the worker claims across tenants (it only ever sees these two tables).
ALTER TABLE media_job        ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_derivative ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_job        FORCE  ROW LEVEL SECURITY;
ALTER TABLE media_derivative FORCE  ROW LEVEL SECURITY;
CREATE POLICY mz_tenant ON media_job        FOR ALL TO mz_app USING (club_id = mz_club()) WITH CHECK (club_id = mz_club());
CREATE POLICY mz_tenant ON media_derivative FOR ALL TO mz_app USING (club_id = mz_club()) WITH CHECK (club_id = mz_club());
CREATE POLICY mz_worker ON media_job        FOR ALL TO mz_worker USING (true) WITH CHECK (true);
CREATE POLICY mz_worker ON media_derivative FOR ALL TO mz_worker USING (true) WITH CHECK (true);
DO $$ BEGIN
  EXECUTE format('CREATE POLICY mz_owner ON media_job        FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY mz_owner ON media_derivative FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- migrate:down
DROP VIEW IF EXISTS v_media_queue_stats;
DROP TABLE IF EXISTS media_derivative;
DROP TABLE IF EXISTS media_job;
