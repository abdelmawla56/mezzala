-- migrate:up
-- Gap G7 / TG spec T1: append-only is a grant, not only a trigger. The app role cannot UPDATE, DELETE
-- or TRUNCATE any table that carries the mz_append_only() trigger, cannot create objects, and cannot
-- switch triggers off (session_replication_role needs superuser). The worker can touch two tables.
-- Call mz_harden_privileges() at the end of any migration that adds tables or append-only triggers.
CREATE OR REPLACE FUNCTION mz_harden_privileges() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  GRANT USAGE ON SCHEMA public TO mz_app, mz_worker;

  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mz_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mz_app;
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM mz_app, mz_worker;

  -- infra-owned tables
  REVOKE ALL ON schema_migrations FROM mz_app, mz_worker;
  REVOKE INSERT, UPDATE, DELETE ON mz_tenant_tables, mz_rls_exempt FROM mz_app;
  REVOKE INSERT, UPDATE, DELETE ON media_derivative FROM mz_app;     -- worker output

  -- append-only tables: found through the trigger, so the list can never drift from the schema
  FOR r IN SELECT DISTINCT tg.tgrelid::regclass AS t
             FROM pg_trigger tg
            WHERE NOT tg.tgisinternal AND tg.tgfoid = to_regproc('mz_append_only')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM mz_app', r.t);
  END LOOP;

  -- worker: nothing but its own two tables
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mz_worker;
  GRANT SELECT, UPDATE ON media_job TO mz_worker;
  GRANT SELECT, INSERT ON media_derivative TO mz_worker;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mz_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mz_app;

SELECT mz_harden_privileges();

-- migrate:down
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mz_app, mz_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mz_app, mz_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM mz_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM mz_app;
DROP FUNCTION IF EXISTS mz_harden_privileges();
