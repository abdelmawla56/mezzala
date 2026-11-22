-- migrate:up
-- TG-ENG-07: the hot foreign keys named in the pack (§6.5). Run EXPLAIN ANALYZE on annotationsOf
-- with ~5,000 seeded revisions before and after; target p95 < 100 ms locally.
CREATE INDEX IF NOT EXISTS annotation_pass_idx          ON annotation (pass_id);
CREATE INDEX IF NOT EXISTS annotation_rev_media_idx     ON annotation_revision (media_asset_id);
CREATE INDEX IF NOT EXISTS qa_decision_annotation_idx   ON qa_decision (annotation_id, id DESC);
CREATE INDEX IF NOT EXISTS tagging_pass_match_idx       ON tagging_pass (match_id);
CREATE INDEX IF NOT EXISTS match_signoff_match_idx      ON match_signoff (match_id, id DESC);
CREATE INDEX IF NOT EXISTS tg_coverage_pass_idx         ON tg_coverage (pass_id, at);

-- migrate:down
DROP INDEX IF EXISTS tg_coverage_pass_idx;
DROP INDEX IF EXISTS match_signoff_match_idx;
DROP INDEX IF EXISTS tagging_pass_match_idx;
DROP INDEX IF EXISTS qa_decision_annotation_idx;
DROP INDEX IF EXISTS annotation_rev_media_idx;
DROP INDEX IF EXISTS annotation_pass_idx;
