-- migrate:up
-- 0005 only added club_id, backfilled it, set NOT NULL and installed the INSERT-time fill trigger when the
-- column was MISSING. A table whose baseline already declared a nullable club_id got the RLS policies and
-- nothing else: NULL rows stayed (invisible to every tenant), nothing stopped new ones, and inserts that
-- do not name club_id were refused. This finishes that job for those tables. Idempotent.
-- Call it (after mz_apply_tenant_rls) from any later migration that adds tenant tables.
CREATE OR REPLACE FUNCTION mz_enforce_club_id() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r record; t regclass; p regclass; fks text[]; fk text; ptype text;
  nullable boolean; has_trg boolean; n bigint;
BEGIN
  FOR r IN SELECT * FROM mz_tenant_tables WHERE parent_table IS NOT NULL ORDER BY table_name LOOP
    t := to_regclass(format('public.%I', r.table_name));
    p := to_regclass(format('public.%I', r.parent_table));
    CONTINUE WHEN t IS NULL OR p IS NULL;
    SELECT NOT a.attnotnull INTO nullable
      FROM pg_attribute a WHERE a.attrelid = t AND a.attname = 'club_id' AND a.attnum > 0 AND NOT a.attisdropped;
    CONTINUE WHEN nullable IS NULL;
    SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = t AND tgname = 'mz_fill_club' AND NOT tgisinternal) INTO has_trg;
    CONTINUE WHEN NOT nullable AND has_trg;

    IF r.fk_column IS NOT NULL THEN
      fks := ARRAY[r.fk_column];
    ELSE
      SELECT array_agg(a.attname::text) INTO fks
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.conrelid = t AND c.confrelid = p AND array_length(c.conkey, 1) = 1;
    END IF;
    IF fks IS NULL OR cardinality(fks) <> 1 THEN
      RAISE WARNING 'mz_enforce_club_id: cannot resolve a single FK from % to %, set fk_column in mz_tenant_tables', r.table_name, r.parent_table;
      CONTINUE;
    END IF;
    fk := fks[1];
    SELECT format_type(a.atttypid, a.atttypmod) INTO ptype
      FROM pg_attribute a WHERE a.attrelid = p AND a.attname = r.parent_pk AND NOT a.attisdropped;

    IF nullable THEN
      EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', t);
      EXECUTE format('UPDATE %s c SET club_id = p.club_id FROM %s p WHERE c.club_id IS NULL AND c.%I = p.%I', t, p, fk, r.parent_pk);
      EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', t);
      EXECUTE format('SELECT count(*) FROM %s WHERE club_id IS NULL', t) INTO n;
      IF n = 0 THEN
        EXECUTE format('ALTER TABLE %s ALTER COLUMN club_id SET NOT NULL', t);
      ELSE
        RAISE WARNING 'mz_enforce_club_id: % still has % orphan rows with no resolvable parent; column left nullable', r.table_name, n;
      END IF;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS mz_fill_club ON %s', t);
    EXECUTE format('CREATE TRIGGER mz_fill_club BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION mz_fill_club_id(%L, %L, %L, %L)',
                   t, p::text, fk, r.parent_pk, ptype);
  END LOOP;
END $$;

SELECT mz_enforce_club_id();

-- migrate:down
DROP FUNCTION IF EXISTS mz_enforce_club_id();
