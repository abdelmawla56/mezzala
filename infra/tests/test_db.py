import psycopg, pytest
from conftest import as_tenant, dbmate

TENANT_TABLES = ["tg_match", "tagging_pass", "annotation", "annotation_revision", "qa_decision",
                 "tg_coverage", "match_signoff", "sync_set", "sync_anchor"]
APPEND_ONLY = ["annotation_revision", "qa_decision", "tg_coverage", "match_signoff", "media_derivative"]


def count(c, t):
    return c.execute(f"SELECT count(*) FROM {t}").fetchone()[0]


def test_unset_tenant_sees_nothing(app):
    for t in TENANT_TABLES:
        assert count(app, t) == 0, t


@pytest.mark.parametrize("club,other", [("GCLUB", "TEST-000"), ("TEST-000", "GCLUB")])
def test_each_tenant_sees_only_its_rows(app, club, other):
    as_tenant(app, club)
    for t in TENANT_TABLES:
        assert count(app, t) >= 1, t
        assert app.execute(f"SELECT count(*) FROM {t} WHERE club_id = %s", [other]).fetchone()[0] == 0, t
    as_tenant(app, club)
    assert count(app, "annotation_revision") == (2 if club == "GCLUB" else 1)   # backfilled via annotation


def test_cross_tenant_insert_refused(app):
    as_tenant(app, "GCLUB")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):           # explicit foreign club_id
        app.execute("INSERT INTO tg_match (club_id, code) VALUES ('TEST-000','X')")


def test_child_of_foreign_parent_refused(app):
    as_tenant(app, "GCLUB")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):           # parent 200 invisible -> club_id NULL -> RLS check fails
        app.execute("INSERT INTO annotation_revision (annotation_id, rev) VALUES (200, 9)")


def test_child_insert_fills_club_id(app):
    as_tenant(app, "GCLUB")
    app.execute("INSERT INTO annotation_revision (annotation_id, rev) VALUES (100, 9)")
    assert app.execute("SELECT club_id FROM annotation_revision WHERE rev = 9").fetchone()[0] == "GCLUB"


@pytest.mark.parametrize("t", APPEND_ONLY)
def test_append_only_by_grant(app, t):
    as_tenant(app, "GCLUB")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        app.execute(f"UPDATE {t} SET club_id = club_id")
    app.rollback(); as_tenant(app, "GCLUB")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        app.execute(f"DELETE FROM {t}")


def test_no_truncate_no_ddl_no_trigger_bypass(app):
    for sql in ("TRUNCATE tg_match CASCADE", "DROP TABLE tg_match", "CREATE TABLE evil (x int)",
                "SET session_replication_role = replica", "ALTER TABLE tg_match DISABLE ROW LEVEL SECURITY"):
        with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.UndefinedTable)):
            app.execute(sql)
        app.rollback()


def test_app_role_is_not_privileged(scratch):
    with psycopg.connect(scratch["url"]) as c:
        row = c.execute("SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname IN ('mz_app','mz_worker')").fetchall()
    assert row and not any(any(r) for r in row)


def test_rls_report_flags_only_the_ambiguous_table(scratch):
    with psycopg.connect(scratch["url"]) as c:
        bad = {r[0] for r in c.execute("SELECT table_name FROM mz_rls_report WHERE status = 'UNTENANTED'")}
    assert bad == {"playlist_item"}        # two FKs to playlist: needs an explicit fk_column


def test_worker_boundaries(scratch):
    with psycopg.connect(scratch["worker"]) as w:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            w.execute("SELECT * FROM annotation")
        w.rollback()
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            w.execute("SELECT * FROM tg_match")
        w.rollback()
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            w.execute("DELETE FROM media_job")


def test_jobs_are_tenant_scoped_for_app_global_for_worker(scratch):
    with psycopg.connect(scratch["app"]) as a:
        for club in ("GCLUB", "TEST-000"):
            as_tenant(a, club)
            a.execute("INSERT INTO media_job (club_id, kind, asset_ref, idempotency_key) VALUES (%s,'probe','1','k1')", [club])
            a.commit()
        as_tenant(a, "GCLUB")
        assert count(a, "media_job") == 1
        with pytest.raises(psycopg.errors.InsufficientPrivilege):       # cannot enqueue for another tenant
            a.execute("INSERT INTO media_job (club_id, kind, asset_ref) VALUES ('TEST-000','probe','2')")
        a.rollback()
        as_tenant(a, "GCLUB")
        with pytest.raises(psycopg.errors.UniqueViolation):             # idempotency key per tenant
            a.execute("INSERT INTO media_job (club_id, kind, asset_ref, idempotency_key) VALUES ('GCLUB','probe','1','k1')")
        a.rollback()
        with pytest.raises(psycopg.errors.InsufficientPrivilege):       # worker output is read-only for the app
            as_tenant(a, "GCLUB")
            a.execute("INSERT INTO media_derivative (club_id, job_id, asset_ref, kind, storage_key) VALUES ('GCLUB',1,'1','proxy','k')")
    with psycopg.connect(scratch["worker"]) as w:
        assert w.execute("SELECT count(*) FROM media_job").fetchone()[0] >= 2     # no tenant set, still sees both
        w.execute("DELETE FROM media_job WHERE false") if False else None


def test_migrations_roll_back_and_reapply(scratch):
    for _ in range(5):
        dbmate(scratch["url"], scratch["mdir"], "rollback")
    with psycopg.connect(scratch["url"]) as c:
        assert c.execute("SELECT to_regclass('media_job')").fetchone()[0] is None
        assert c.execute("SELECT relrowsecurity FROM pg_class WHERE relname='tg_match'").fetchone()[0] is False
    dbmate(scratch["url"], scratch["mdir"], "up")
    with psycopg.connect(scratch["app"]) as a:
        as_tenant(a, "GCLUB")
        assert count(a, "annotation_revision") >= 2
