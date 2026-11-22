"""Spins up a scratch database, applies the real migrations on top of the fixture baseline."""
import os, shutil, subprocess, tempfile, uuid
from pathlib import Path
import psycopg, pytest

ROOT = Path(__file__).resolve().parent.parent
HOST = os.environ.get("PGHOST", "127.0.0.1")
PORT = os.environ.get("PGPORT", "5432")
SUPER = os.environ.get("MZ_TEST_SUPERUSER", "postgres")
SUPER_PW = os.environ.get("MZ_TEST_SUPERUSER_PASSWORD", "pg")
APP_PW, WORKER_PW = "app-test-pw", "worker-test-pw"
DBMATE = os.environ.get("DBMATE", "dbmate")


def dsn(user, pw, db):
    return f"postgresql://{user}:{pw}@{HOST}:{PORT}/{db}"


def dbmate(url, mdir, *args):
    env = dict(os.environ, DATABASE_URL=url + "?sslmode=disable", DBMATE_MIGRATIONS_DIR=str(mdir),
               DBMATE_NO_DUMP_SCHEMA="true")
    return subprocess.run([DBMATE, *args], env=env, capture_output=True, text=True, check=True)


@pytest.fixture(scope="session")
def scratch():
    name = "mz_test_" + uuid.uuid4().hex[:8]
    with psycopg.connect(dsn(SUPER, SUPER_PW, "postgres"), autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    env = dict(os.environ, PGHOST=HOST, PGPORT=PORT, PGUSER=SUPER, PGPASSWORD=SUPER_PW,
               MZ_APP_PASSWORD=APP_PW, MZ_WORKER_PASSWORD=WORKER_PW)
    subprocess.run([str(ROOT / "scripts/create-roles.sh"), name], env=env, check=True, capture_output=True)
    mdir = Path(tempfile.mkdtemp())
    for f in (ROOT / "db/migrations").glob("*.sql"):
        shutil.copy(f, mdir / f.name)
    shutil.copy(ROOT / "tests/fixture_schema.sql", mdir / "0001_baseline.sql")
    url = dsn(SUPER, SUPER_PW, name)
    dbmate(url, mdir, "up")
    yield dict(name=name, mdir=mdir, url=url,
               app=dsn("mz_app", APP_PW, name), worker=dsn("mz_worker", WORKER_PW, name))
    with psycopg.connect(dsn(SUPER, SUPER_PW, "postgres"), autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture()
def app(scratch):
    with psycopg.connect(scratch["app"]) as c:
        yield c
        c.rollback()


def as_tenant(conn, club):
    conn.execute("SELECT set_config('app.club_id', %s, true)", [club])
