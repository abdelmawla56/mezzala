-- migrate:up
-- TEST-ONLY stand-in for apps/web/db/schema.sql. Same table and column names the pack documents,
-- reduced to what the infra migrations touch. CI against the real schema uses `make baseline` instead.
CREATE TABLE tenant (id text PRIMARY KEY, name text);
CREATE TABLE users (id serial PRIMARY KEY, email text, role text);
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id int REFERENCES users(id), expires_at timestamptz);

CREATE FUNCTION mz_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;

CREATE TABLE tg_match (id serial PRIMARY KEY, club_id text NOT NULL REFERENCES tenant(id), code text);
CREATE TABLE tagging_pass (id serial PRIMARY KEY, match_id int NOT NULL REFERENCES tg_match(id), status text DEFAULT 'open');
CREATE TABLE annotation (id serial PRIMARY KEY, club_id text NOT NULL REFERENCES tenant(id),
                         match_id int NOT NULL REFERENCES tg_match(id), pass_id int REFERENCES tagging_pass(id));
CREATE TABLE annotation_revision (id serial PRIMARY KEY, annotation_id int NOT NULL REFERENCES annotation(id),
                                  rev int NOT NULL, media_asset_id int, UNIQUE (annotation_id, rev));
CREATE TABLE qa_decision (id serial PRIMARY KEY, annotation_id int NOT NULL REFERENCES annotation(id), decision text);
CREATE TABLE tg_coverage (id serial PRIMARY KEY, pass_id int NOT NULL REFERENCES tagging_pass(id), at timestamptz DEFAULT now());
CREATE TABLE match_signoff (id serial PRIMARY KEY, match_id int NOT NULL REFERENCES tg_match(id), action text);
CREATE TABLE sync_set (id serial PRIMARY KEY, match_id int NOT NULL REFERENCES tg_match(id));
CREATE TABLE sync_anchor (id serial PRIMARY KEY, sync_set_id int NOT NULL REFERENCES sync_set(id), video_ms int);
-- deliberately ambiguous: two FKs to playlist, so the report must flag it
CREATE TABLE playlist (id serial PRIMARY KEY, club_id text NOT NULL REFERENCES tenant(id));
CREATE TABLE playlist_item (id serial PRIMARY KEY, playlist_id int REFERENCES playlist(id), copied_from int REFERENCES playlist(id));

CREATE TRIGGER mz_ao BEFORE UPDATE OR DELETE ON annotation_revision FOR EACH ROW EXECUTE FUNCTION mz_append_only();
CREATE TRIGGER mz_ao BEFORE UPDATE OR DELETE ON qa_decision         FOR EACH ROW EXECUTE FUNCTION mz_append_only();
CREATE TRIGGER mz_ao BEFORE UPDATE OR DELETE ON tg_coverage         FOR EACH ROW EXECUTE FUNCTION mz_append_only();
CREATE TRIGGER mz_ao BEFORE UPDATE OR DELETE ON match_signoff       FOR EACH ROW EXECUTE FUNCTION mz_append_only();

INSERT INTO tenant VALUES ('GCLUB','G Club'), ('TEST-000','Test');
INSERT INTO users (email, role) VALUES ('a@x.test','admin');
INSERT INTO tg_match (id, club_id, code) VALUES (1,'GCLUB','M1'), (2,'TEST-000','T1');
INSERT INTO tagging_pass (id, match_id) VALUES (10,1), (20,2);
INSERT INTO annotation (id, club_id, match_id, pass_id) VALUES (100,'GCLUB',1,10), (200,'TEST-000',2,20);
INSERT INTO annotation_revision (annotation_id, rev) VALUES (100,1), (100,2), (200,1);
INSERT INTO qa_decision (annotation_id, decision) VALUES (100,'accept'), (200,'reject');
INSERT INTO tg_coverage (pass_id) VALUES (10), (20);
INSERT INTO match_signoff (match_id, action) VALUES (1,'sign'), (2,'sign');
INSERT INTO sync_set (id, match_id) VALUES (1,1), (2,2);
INSERT INTO sync_anchor (sync_set_id, video_ms) VALUES (1,0), (2,0);
INSERT INTO playlist (id, club_id) VALUES (1,'GCLUB');
INSERT INTO playlist_item (playlist_id) VALUES (1);

-- migrate:down
SELECT 1;
