-- migrate:up
-- ============================================================
-- apps/web/db/schema.sql
-- MEZZALA tagging system schema (Postgres 16, idempotent).
-- `make baseline` in infra/ copies this into 0001_baseline.sql.
-- DO NOT edit 0001 after it has been applied; add a new migration.
-- ============================================================

-- ── Core tenant registry ────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant (
  id   text PRIMARY KEY,
  name text NOT NULL
);

-- ── Users & sessions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         serial PRIMARY KEY,
  email      text   NOT NULL UNIQUE,
  role       text   NOT NULL DEFAULT 'tagger',
  club_id    text   REFERENCES tenant(id),
  magic_link text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id    int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verify_state (
  id         serial PRIMARY KEY,
  email      text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false
);

-- ── Audit log ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  user_id    int REFERENCES users(id),
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Taxonomy ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS taxonomy_version (
  id         serial PRIMARY KEY,
  version    text NOT NULL UNIQUE,
  frozen_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS taxonomy_term (
  id                  serial PRIMARY KEY,
  taxonomy_version_id int  NOT NULL REFERENCES taxonomy_version(id),
  code                text NOT NULL,
  label_en            text NOT NULL,
  label_ar            text NOT NULL,
  parent_code         text,
  sort_order          int  NOT NULL DEFAULT 0,
  UNIQUE (taxonomy_version_id, code)
);

-- ── Tag templates ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tag_template (
  id         serial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tag_template_version (
  id               serial PRIMARY KEY,
  tag_template_id  int  NOT NULL REFERENCES tag_template(id),
  version          int  NOT NULL,
  schema_json      jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tag_template_id, version)
);

-- ── Matches ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_match (
  id         serial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  code       text NOT NULL,
  home_team  text,
  away_team  text,
  match_date date,
  status     text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tg_team (
  id      serial PRIMARY KEY,
  club_id text NOT NULL REFERENCES tenant(id),
  name    text NOT NULL,
  code    text NOT NULL,
  UNIQUE (club_id, code)
);

CREATE TABLE IF NOT EXISTS tg_match_status (
  id         bigserial PRIMARY KEY,
  match_id   int NOT NULL REFERENCES tg_match(id),
  club_id    text NOT NULL REFERENCES tenant(id),
  status     text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by int REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tg_lineup (
  id       serial PRIMARY KEY,
  match_id int NOT NULL REFERENCES tg_match(id),
  club_id  text NOT NULL REFERENCES tenant(id),
  team     text NOT NULL,
  position text,
  player   text NOT NULL
);

CREATE TABLE IF NOT EXISTS tg_minors (
  id         serial PRIMARY KEY,
  match_id   int NOT NULL REFERENCES tg_match(id),
  club_id    text NOT NULL REFERENCES tenant(id),
  player     text NOT NULL,
  birth_date date,
  guardian   text
);

CREATE TABLE IF NOT EXISTS tg_timeline (
  id         bigserial PRIMARY KEY,
  match_id   int  NOT NULL REFERENCES tg_match(id),
  club_id    text NOT NULL REFERENCES tenant(id),
  event_code text NOT NULL,
  match_ms   bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tg_direction (
  id         bigserial PRIMARY KEY,
  match_id   int  NOT NULL REFERENCES tg_match(id),
  club_id    text NOT NULL REFERENCES tenant(id),
  period     int  NOT NULL,
  attack_dir text NOT NULL
);

-- ── Assignments ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tg_assignment (
  id         serial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  match_id   int  NOT NULL REFERENCES tg_match(id),
  user_id    int  NOT NULL REFERENCES users(id),
  role       text NOT NULL DEFAULT 'tagger',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS counting_assignment (
  id       serial PRIMARY KEY,
  match_id int  NOT NULL REFERENCES tg_match(id),
  club_id  text NOT NULL REFERENCES tenant(id),
  user_id  int  NOT NULL REFERENCES users(id)
);

-- ── Tagger profile / invites ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tagger_profile (
  id      serial PRIMARY KEY,
  user_id int NOT NULL UNIQUE REFERENCES users(id),
  bio     text
);

CREATE TABLE IF NOT EXISTS tg_invite (
  id         serial PRIMARY KEY,
  email      text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS squad_member (
  id      serial PRIMARY KEY,
  user_id int  NOT NULL REFERENCES users(id),
  name    text NOT NULL,
  code    text NOT NULL
);

-- ── Tenant flags ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_flag (
  id      serial PRIMARY KEY,
  club_id text NOT NULL REFERENCES tenant(id),
  flag    text NOT NULL,
  value   text,
  UNIQUE (club_id, flag)
);

-- ── Rights records (media) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS rights_record (
  id         serial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  match_id   int  REFERENCES tg_match(id),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to   timestamptz,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Media assets ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_asset (
  id               serial PRIMARY KEY,
  club_id          text NOT NULL REFERENCES tenant(id),
  match_id         int  NOT NULL REFERENCES tg_match(id),
  s3_key           text,
  filename         text NOT NULL,
  mime_type        text,
  bytes            bigint,
  sha256           text,
  duration_ms      bigint,
  width            int,
  height           int,
  fps              numeric,
  video_codec      text,
  audio_codec      text,
  bit_rate         bigint,
  container        text,
  keyframe_max_gap_s numeric,
  upload_state     text NOT NULL DEFAULT 'pending',
  upload_part_data jsonb,
  proxy_key        text,
  rights_id        int REFERENCES rights_record(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS match_video (
  id           serial PRIMARY KEY,
  match_id     int  NOT NULL REFERENCES tg_match(id),
  media_asset_id int REFERENCES media_asset(id),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Sync / coverage ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_set (
  id       serial PRIMARY KEY,
  match_id int NOT NULL REFERENCES tg_match(id),
  club_id  text NOT NULL REFERENCES tenant(id),
  label    text
);

CREATE TABLE IF NOT EXISTS sync_anchor (
  id          serial PRIMARY KEY,
  sync_set_id int NOT NULL REFERENCES sync_set(id),
  club_id     text,
  video_ms    bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_gap (
  id          serial PRIMARY KEY,
  sync_set_id int    NOT NULL REFERENCES sync_set(id),
  club_id     text,
  start_ms    bigint NOT NULL,
  end_ms      bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS media_exclusion (
  id          serial PRIMARY KEY,
  sync_set_id int    NOT NULL REFERENCES sync_set(id),
  club_id     text,
  reason      text
);

-- ── Tagging passes ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tagging_pass (
  id         serial PRIMARY KEY,
  match_id   int  NOT NULL REFERENCES tg_match(id),
  club_id    text,
  status     text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tg_coverage (
  id      bigserial PRIMARY KEY,
  pass_id int  NOT NULL REFERENCES tagging_pass(id),
  club_id text,
  at      timestamptz NOT NULL DEFAULT now()
);

-- ── Annotations (append-only body) ──────────────────────────
CREATE FUNCTION IF NOT EXISTS mz_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: corrections must be new revisions', TG_TABLE_NAME;
END $$;

CREATE TABLE IF NOT EXISTS annotation (
  id         serial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  match_id   int  NOT NULL REFERENCES tg_match(id),
  pass_id    int  REFERENCES tagging_pass(id),
  kind       text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS annotation_revision (
  id              serial  PRIMARY KEY,
  annotation_id   int     NOT NULL REFERENCES annotation(id),
  rev             int     NOT NULL,
  media_asset_id  int     REFERENCES media_asset(id),
  match_ms        bigint,
  payload         jsonb   NOT NULL DEFAULT '{}',
  created_by      int     REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (annotation_id, rev)
);

-- ── QA ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qa_decision (
  id              bigserial PRIMARY KEY,
  annotation_id   int  NOT NULL REFERENCES annotation(id),
  club_id         text,
  decision        text NOT NULL CHECK (decision IN ('accept','reject','defer')),
  decided_by      int  REFERENCES users(id),
  decided_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qa_sample_policy (
  id         serial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  rate       numeric NOT NULL DEFAULT 1,
  kind       text NOT NULL DEFAULT 'all'
);

CREATE TABLE IF NOT EXISTS qa_tolerance (
  id      serial PRIMARY KEY,
  club_id text NOT NULL REFERENCES tenant(id),
  metric  text NOT NULL,
  value   numeric NOT NULL
);

CREATE TABLE IF NOT EXISTS qa_pending_signature (
  id         bigserial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  annotation_id int NOT NULL REFERENCES annotation(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Adjudication / agreement ─────────────────────────────────
CREATE TABLE IF NOT EXISTS adjudication (
  id         serial PRIMARY KEY,
  match_id   int  NOT NULL REFERENCES tg_match(id),
  club_id    text NOT NULL REFERENCES tenant(id),
  status     text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agreement_run (
  id       serial PRIMARY KEY,
  match_id int  NOT NULL REFERENCES tg_match(id),
  club_id  text NOT NULL REFERENCES tenant(id),
  score    numeric,
  run_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Match sign-off ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS match_signoff (
  id         bigserial PRIMARY KEY,
  match_id   int  NOT NULL REFERENCES tg_match(id),
  club_id    text,
  action     text NOT NULL,
  signed_by  int  REFERENCES users(id),
  signed_at  timestamptz NOT NULL DEFAULT now()
);

-- ── AI models / gates ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_model (
  id         serial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'tagging',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_model_gate (
  id         serial PRIMARY KEY,
  ai_model_id int NOT NULL REFERENCES ai_model(id),
  club_id    text,
  enabled    boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS ai_model_threshold (
  id          serial PRIMARY KEY,
  ai_model_id int     NOT NULL REFERENCES ai_model(id),
  club_id     text,
  metric      text    NOT NULL,
  threshold   numeric NOT NULL
);

CREATE TABLE IF NOT EXISTS model_run (
  id         bigserial PRIMARY KEY,
  match_id   int  NOT NULL REFERENCES tg_match(id),
  club_id    text NOT NULL REFERENCES tenant(id),
  ai_model_id int REFERENCES ai_model(id),
  status     text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_run (
  id         bigserial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  match_id   int  REFERENCES tg_match(id),
  kind       text NOT NULL,
  status     text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Event snapshots ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_snapshot (
  id         bigserial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  match_id   int  NOT NULL REFERENCES tg_match(id),
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Playlists ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS playlist (
  id         serial PRIMARY KEY,
  club_id    text NOT NULL REFERENCES tenant(id),
  name       text NOT NULL,
  created_by int  REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playlist_item (
  id          serial PRIMARY KEY,
  playlist_id int REFERENCES playlist(id),
  club_id     text,
  annotation_id int REFERENCES annotation(id),
  copied_from int REFERENCES playlist(id),
  sort_order  int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS playlist_share (
  id          serial PRIMARY KEY,
  playlist_id int NOT NULL REFERENCES playlist(id),
  club_id     text,
  shared_with int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playlist_comment (
  id          bigserial PRIMARY KEY,
  playlist_id int NOT NULL REFERENCES playlist(id),
  club_id     text,
  user_id     int REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Views ────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_annotation_current AS
SELECT ar.*
FROM annotation_revision ar
WHERE ar.rev = (
  SELECT max(ar2.rev)
  FROM annotation_revision ar2
  WHERE ar2.annotation_id = ar.annotation_id
);

-- ── Append-only triggers ─────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mz_ao_annotation_revision') THEN
    CREATE TRIGGER mz_ao_annotation_revision BEFORE UPDATE OR DELETE ON annotation_revision
      FOR EACH ROW EXECUTE FUNCTION mz_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mz_ao_qa_decision') THEN
    CREATE TRIGGER mz_ao_qa_decision BEFORE UPDATE OR DELETE ON qa_decision
      FOR EACH ROW EXECUTE FUNCTION mz_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mz_ao_tg_coverage') THEN
    CREATE TRIGGER mz_ao_tg_coverage BEFORE UPDATE OR DELETE ON tg_coverage
      FOR EACH ROW EXECUTE FUNCTION mz_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mz_ao_match_signoff') THEN
    CREATE TRIGGER mz_ao_match_signoff BEFORE UPDATE OR DELETE ON match_signoff
      FOR EACH ROW EXECUTE FUNCTION mz_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mz_ao_audit_log') THEN
    CREATE TRIGGER mz_ao_audit_log BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION mz_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mz_ao_tg_timeline') THEN
    CREATE TRIGGER mz_ao_tg_timeline BEFORE UPDATE OR DELETE ON tg_timeline
      FOR EACH ROW EXECUTE FUNCTION mz_append_only();
  END IF;
END $$;

-- ── Seed tenants ─────────────────────────────────────────────
INSERT INTO tenant (id, name) VALUES ('GCLUB', 'G Club'), ('TEST-000', 'Test Club')
  ON CONFLICT (id) DO NOTHING;

-- migrate:down
SELECT 1;
