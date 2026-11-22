-- migrate:up
-- TAG-NFR-05 / gaps G5 + G7: club_id on every tenant table + forced row-level security.
-- mz_apply_tenant_rls() is data-driven (mz_tenant_tables) and idempotent. For each listed table it
--   1. adds club_id if missing and backfills it from the parent via the discovered FK,
--      with user triggers switched off for the backfill (append-only triggers would refuse it),
--   2. sets NOT NULL when no orphan rows remain, installs the INSERT-time club_id fill trigger,
--   3. ENABLE + FORCE RLS, policy mz_tenant for mz_app (club_id = mz_club()), policy mz_owner for the
--      migration role so migrations and ops keep working.
-- Anything it cannot resolve is a WARNING and shows as UNTENANTED in mz_rls_report: fix the config row.
CREATE OR REPLACE FUNCTION mz_apply_tenant_rls() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r record; t regclass; p regclass; fks text[]; fk text; ptype text; has_club boolean; phas boolean;
  done text[] := '{}'; progressed boolean; pending_parent boolean;
BEGIN
  LOOP
    progressed := false;
    FOR r IN SELECT * FROM mz_tenant_tables ORDER BY table_name LOOP
      CONTINUE WHEN r.table_name = ANY (done);
      t := to_regclass(format('public.%I', r.table_name));
      IF t IS NULL THEN
        RAISE NOTICE 'mz_apply_tenant_rls: % does not exist, skipped', r.table_name;
        done := done || r.table_name; progressed := true; CONTINUE;
      END IF;
      SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = t AND attname = 'club_id' AND attnum > 0 AND NOT attisdropped)
        INTO has_club;

      IF NOT has_club THEN
        IF r.parent_table IS NULL THEN
          RAISE WARNING 'mz_apply_tenant_rls: % has no club_id and no parent configured', r.table_name;
          done := done || r.table_name; progressed := true; CONTINUE;
        END IF;
        p := to_regclass(format('public.%I', r.parent_table));
        IF p IS NULL THEN
          RAISE WARNING 'mz_apply_tenant_rls: parent % of % does not exist', r.parent_table, r.table_name;
          done := done || r.table_name; progressed := true; CONTINUE;
        END IF;
        SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p AND attname = 'club_id' AND attnum > 0 AND NOT attisdropped)
          INTO phas;
        IF NOT phas THEN
          SELECT EXISTS (SELECT 1 FROM mz_tenant_tables m WHERE m.table_name = r.parent_table AND NOT (m.table_name = ANY (done)))
            INTO pending_parent;
          IF pending_parent THEN CONTINUE; END IF;      -- wait for the parent's pass
          RAISE WARNING 'mz_apply_tenant_rls: parent % of % has no club_id', r.parent_table, r.table_name;
          done := done || r.table_name; progressed := true; CONTINUE;
        END IF;
        IF r.fk_column IS NOT NULL THEN
          fks := ARRAY[r.fk_column];
        ELSE
          SELECT array_agg(a.attname::text) INTO fks
            FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
           WHERE c.contype = 'f' AND c.conrelid = t AND c.confrelid = p AND array_length(c.conkey, 1) = 1;
        END IF;
        IF fks IS NULL OR cardinality(fks) <> 1 THEN
          RAISE WARNING 'mz_apply_tenant_rls: cannot resolve a single FK from % to %, set fk_column in mz_tenant_tables', r.table_name, r.parent_table;
          done := done || r.table_name; progressed := true; CONTINUE;
        END IF;
        fk := fks[1];
        SELECT format_type(a.atttypid, a.atttypmod) INTO ptype
          FROM pg_attribute a WHERE a.attrelid = p AND a.attname = r.parent_pk AND NOT a.attisdropped;

        EXECUTE format('ALTER TABLE %s ADD COLUMN club_id text', t);
        EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', t);
        EXECUTE format('UPDATE %s c SET club_id = p.club_id FROM %s p WHERE c.%I = p.%I', t, p, fk, r.parent_pk);
        EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', t);
        EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM %s WHERE club_id IS NULL)', t) INTO has_club;
        IF has_club THEN
          EXECUTE format('ALTER TABLE %s ALTER COLUMN club_id SET NOT NULL', t);
        ELSE
          RAISE WARNING 'mz_apply_tenant_rls: % has orphan rows (club_id NULL); column left nullable', r.table_name;
        END IF;
        EXECUTE format('DROP TRIGGER IF EXISTS mz_fill_club ON %s', t);
        EXECUTE format('CREATE TRIGGER mz_fill_club BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION mz_fill_club_id(%L, %L, %L, %L)',
                       t, p::text, fk, r.parent_pk, ptype);
      END IF;

      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS mz_tenant ON %s', t);
      EXECUTE format('DROP POLICY IF EXISTS mz_owner ON %s', t);
      EXECUTE format('CREATE POLICY mz_tenant ON %s FOR ALL TO mz_app USING (club_id = mz_club()) WITH CHECK (club_id = mz_club())', t);
      EXECUTE format('CREATE POLICY mz_owner ON %s FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
      done := done || r.table_name; progressed := true;
    END LOOP;
    EXIT WHEN NOT progressed;
  END LOOP;
  FOR r IN SELECT table_name FROM mz_tenant_tables WHERE NOT (table_name = ANY (done)) LOOP
    RAISE WARNING 'mz_apply_tenant_rls: % not processed (parent cycle?)', r.table_name;
  END LOOP;
END $$;

-- Who reaches their tenant how. Roots are expected to carry club_id already (the pack: tenant_flag,
-- tg_match, ...). Children get it from the named parent. Confirm against the real schema with
--   SELECT * FROM mz_rls_report WHERE status = 'UNTENANTED';
INSERT INTO mz_tenant_tables (table_name, parent_table) VALUES
  ('tg_team', NULL), ('tg_match', NULL), ('tenant_flag', NULL), ('rights_record', NULL),
  ('tag_template', NULL), ('qa_sample_policy', NULL), ('qa_tolerance', NULL), ('ai_model', NULL),
  ('playlist', NULL), ('tg_assignment', NULL), ('event_snapshot', NULL), ('analysis_run', NULL),
  ('qa_pending_signature', NULL),
  ('tagging_pass', 'tg_match'), ('annotation', 'tg_match'), ('media_asset', 'tg_match'),
  ('tg_match_status', 'tg_match'), ('tg_lineup', 'tg_match'), ('tg_minors', 'tg_match'),
  ('tg_timeline', 'tg_match'), ('tg_direction', 'tg_match'), ('sync_set', 'tg_match'),
  ('adjudication', 'tg_match'), ('agreement_run', 'tg_match'), ('counting_assignment', 'tg_match'),
  ('match_signoff', 'tg_match'), ('model_run', 'tg_match'),
  ('annotation_revision', 'annotation'), ('qa_decision', 'annotation'),
  ('tg_coverage', 'tagging_pass'),
  ('sync_anchor', 'sync_set'), ('media_gap', 'sync_set'), ('media_exclusion', 'sync_set'),
  ('tag_template_version', 'tag_template'),
  ('ai_model_gate', 'ai_model'), ('ai_model_threshold', 'ai_model'),
  ('playlist_item', 'playlist'), ('playlist_share', 'playlist'), ('playlist_comment', 'playlist')
ON CONFLICT DO NOTHING;

INSERT INTO mz_rls_exempt (table_name, reason) VALUES
  ('tenant',            'tenant registry, readable by the app'),
  ('taxonomy_version',  'global meaning layer, shared by tenants (freezeTaxonomy is global today)'),
  ('taxonomy_term',     'global meaning layer'),
  ('users',             'DEBT T3: users are not tenant members; needs auth/schema change before a 2nd club'),
  ('sessions',          'DEBT T3: same as users'),
  ('audit_log',         'DEBT: legacy, no club_id'),
  ('verify_state',      'DEBT: legacy, no club_id'),
  ('match_video',       'DEBT: legacy, no club_id'),
  ('squad_member',      'DEBT T2: legacy, no club_id'),
  ('tagger_profile',    'DEBT T2: tagger lists are global by user role'),
  ('tg_invite',         'DEBT T2: tagger lists are global by user role'),
  ('mz_tenant_tables',  'infra config'),
  ('mz_rls_exempt',     'infra config'),
  ('schema_migrations', 'dbmate bookkeeping')
ON CONFLICT DO NOTHING;

SELECT mz_apply_tenant_rls();

CREATE OR REPLACE VIEW mz_rls_report AS
SELECT c.relname::text AS table_name,
       h.has_club_id,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
       e.reason AS exempt_reason,
       CASE WHEN e.table_name IS NOT NULL THEN 'exempt'
            WHEN h.has_club_id AND c.relrowsecurity AND c.relforcerowsecurity THEN 'ok'
            ELSE 'UNTENANTED' END AS status
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                       AND a.attname = 'club_id' AND a.attnum > 0 AND NOT a.attisdropped) AS has_club_id) h
  LEFT JOIN mz_rls_exempt e ON e.table_name = c.relname
 WHERE c.relkind = 'r';

-- migrate:down
DROP VIEW IF EXISTS mz_rls_report;
DO $$
DECLARE r record; t regclass;
BEGIN
  FOR r IN SELECT table_name FROM mz_tenant_tables LOOP
    t := to_regclass(format('public.%I', r.table_name));
    CONTINUE WHEN t IS NULL;
    EXECUTE format('DROP POLICY IF EXISTS mz_tenant ON %s', t);
    EXECUTE format('DROP POLICY IF EXISTS mz_owner ON %s', t);
    EXECUTE format('DROP TRIGGER IF EXISTS mz_fill_club ON %s', t);
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
DELETE FROM mz_rls_exempt;
DELETE FROM mz_tenant_tables;
DROP FUNCTION IF EXISTS mz_apply_tenant_rls();
