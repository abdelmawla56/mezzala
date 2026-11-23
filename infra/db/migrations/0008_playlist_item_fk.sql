
-- migrate:up

UPDATE mz_tenant_tables SET fk_column = 'playlist_id' WHERE table_name = 'playlist_item';

SELECT mz_enforce_club_id();

-- migrate:down

UPDATE mz_tenant_tables SET fk_column = NULL WHERE table_name = 'playlist_item';

