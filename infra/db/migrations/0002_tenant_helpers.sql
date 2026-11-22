-- migrate:up
-- Tenant context. The app sets it per transaction: SELECT set_config('app.club_id', $1, true)
-- (see contracts/with-tenant.ts). Unset or empty => NULL => every tenant policy matches nothing.
CREATE OR REPLACE FUNCTION mz_club() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.club_id', true), '')
$$;

-- Child tables without their own club_id get it from their parent on INSERT, so existing
-- INSERT statements in the app keep working. The parent lookup runs as the caller, i.e. under
-- RLS: a parent that belongs to another tenant is invisible, club_id stays NULL, NOT NULL fails.
-- args: parent table, fk column on this table, parent pk column, parent pk type
CREATE OR REPLACE FUNCTION mz_fill_club_id() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  IF NEW.club_id IS NULL THEN
    EXECUTE format('SELECT club_id FROM %s WHERE %I = $1::%s', TG_ARGV[0], TG_ARGV[2], TG_ARGV[3])
      INTO v USING (to_jsonb(NEW) ->> TG_ARGV[1]);
    NEW.club_id := v;
  END IF;
  RETURN NEW;
END $$;

-- Which tables are tenant-scoped and how they reach their tenant. Extend with a migration, then
-- SELECT mz_apply_tenant_rls(); (idempotent).
CREATE TABLE mz_tenant_tables (
  table_name   text PRIMARY KEY,
  parent_table text,                     -- NULL: the table must already carry club_id
  fk_column    text,                     -- NULL: discovered from the foreign key to parent_table
  parent_pk    text NOT NULL DEFAULT 'id'
);

-- Tables deliberately outside RLS. Every entry is documented technical debt or a global table.
CREATE TABLE mz_rls_exempt (
  table_name text PRIMARY KEY,
  reason     text NOT NULL
);

-- migrate:down
DROP TABLE IF EXISTS mz_rls_exempt;
DROP TABLE IF EXISTS mz_tenant_tables;
DROP FUNCTION IF EXISTS mz_fill_club_id();
DROP FUNCTION IF EXISTS mz_club();
