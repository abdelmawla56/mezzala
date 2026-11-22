"""End to end: real Postgres (migrations + RLS), real ffmpeg, S3 API served by moto."""
import dataclasses, hashlib, subprocess, sys
from pathlib import Path

import boto3, psycopg, pytest
from moto.server import ThreadedMotoServer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))
from mz_worker import queue                      # noqa: E402
from mz_worker.config import Config              # noqa: E402
from mz_worker.main import run_once              # noqa: E402
from mz_worker.storage import Storage            # noqa: E402
from conftest import as_tenant                   # noqa: E402

BUCKET, KEY = "mezzala-media", "GCLUB/m1/a1/original.mp4"


@pytest.fixture(scope="module")
def s3(tmp_path_factory):
    srv = ThreadedMotoServer(port=5599, verbose=False)
    srv.start()
    import os
    os.environ.update(AWS_ACCESS_KEY_ID="t", AWS_SECRET_ACCESS_KEY="t")
    c = boto3.client("s3", endpoint_url="http://127.0.0.1:5599", region_name="eu-central-1")
    c.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "eu-central-1"})
    vid = tmp_path_factory.mktemp("v") / "orig.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=6",
                    "-f", "lavfi", "-i", "sine=duration=6", "-c:v", "libx264", "-g", "150", "-keyint_min", "150",
                    "-sc_threshold", "0", "-c:a", "aac", "-movflags", "+faststart", str(vid)], check=True)
    c.upload_file(str(vid), BUCKET, KEY)
    yield dict(client=c, sha=hashlib.sha256(vid.read_bytes()).hexdigest())
    srv.stop()


@pytest.fixture()
def env(scratch, s3):
    cfg = Config(database_url=scratch["worker"], bucket=BUCKET, endpoint_url="http://127.0.0.1:5599",
                 worker_id="test-1", thumb_interval=2, proxy_height=360)
    with psycopg.connect(scratch["url"], autocommit=True) as su:
        su.execute("TRUNCATE media_derivative, media_job CASCADE")
    return cfg, Storage(cfg), queue.connect(scratch["worker"]), scratch


def enqueue(scratch, club, kind, key, **extra):
    with psycopg.connect(scratch["app"]) as a:
        as_tenant(a, club)
        a.execute("INSERT INTO media_job (club_id, kind, asset_ref, payload, max_attempts) VALUES (%s,%s,'a1',%s::jsonb,2)",
                  [club, kind, psycopg.types.json.Jsonb({"key": key, **extra})])
        a.commit()


def drain(cfg, st, conn):
    while run_once(cfg, conn, st):
        pass


def test_full_pipeline(env, s3):
    cfg, st, conn, scratch = env
    for kind, extra in (("probe", {}), ("hash", {"expected_sha256": s3["sha"]}), ("proxy", {}), ("thumbnails", {})):
        enqueue(scratch, "GCLUB", kind, KEY, **extra)
    drain(cfg, st, conn)
    rows = {r["kind"]: r for r in conn.execute("SELECT * FROM media_job").fetchall()}
    assert {k: r["status"] for k, r in rows.items()} == dict.fromkeys(("probe", "hash", "proxy", "thumbnails"), "succeeded")
    p = rows["probe"]["result"]
    assert 5900 <= p["duration_ms"] <= 6100 and p["width"] == 1280 and p["video_codec"] == "h264"
    assert p["keyframe_max_gap_s"] is None or p["keyframe_max_gap_s"] >= 5       # original: sparse keyframes
    assert rows["hash"]["result"]["sha256"] == s3["sha"] and rows["hash"]["result"]["matches_expected"] is True
    assert rows["proxy"]["result"]["height"] == 360
    assert rows["proxy"]["result"]["keyframe_max_gap_s"] <= 1.2                   # the whole point of the proxy
    derivs = conn.execute("SELECT kind, storage_key FROM media_derivative ORDER BY id").fetchall()
    assert sum(d["kind"] == "thumbnail" for d in derivs) == 3 and sum(d["kind"] == "proxy" for d in derivs) == 1
    for d in derivs:
        assert d["storage_key"].startswith("GCLUB/derived/a1/")
        st.head(d["storage_key"])                                                  # object really exists


def test_tenant_prefix_escape_fails_permanently(env):
    cfg, st, conn, scratch = env
    enqueue(scratch, "GCLUB", "hash", "TEST-000/m9/other/original.mp4")
    drain(cfg, st, conn)
    r = conn.execute("SELECT status, attempts, last_error FROM media_job").fetchone()
    assert r["status"] == "failed" and "outside" in r["last_error"]


def test_missing_object_retries_then_fails(env):
    cfg, st, conn, scratch = env
    enqueue(scratch, "GCLUB", "hash", "GCLUB/m1/nope.mp4")
    drain(cfg, st, conn)
    r = conn.execute("SELECT status, attempts, run_after > now() AS backoff FROM media_job").fetchone()
    assert (r["status"], r["attempts"], r["backoff"]) == ("queued", 1, True)       # transient: requeued with backoff
    conn.execute("UPDATE media_job SET run_after = now()")
    drain(cfg, st, conn)
    assert conn.execute("SELECT status, attempts FROM media_job").fetchone() == {"status": "failed", "attempts": 2}


def test_dead_worker_lease_is_reaped(env):
    cfg, st, conn, scratch = env
    enqueue(scratch, "GCLUB", "probe", KEY)
    job = queue.claim(conn, "dead-worker")                        # claimed, never finished
    conn.execute("UPDATE media_job SET heartbeat_at = now() - interval '10 minutes'")
    assert queue.reap(conn, 120) == 1
    assert conn.execute("SELECT status FROM media_job").fetchone()["status"] == "queued"
    drain(cfg, st, conn)
    assert conn.execute("SELECT status FROM media_job").fetchone()["status"] == "succeeded"


def test_cancelled_job_is_not_resurrected(env):
    cfg, st, conn, scratch = env
    enqueue(scratch, "GCLUB", "probe", KEY)
    job = queue.claim(conn, cfg.worker_id)
    conn.execute("UPDATE media_job SET status = 'cancelled', locked_by = NULL")      # app cancels mid-run
    assert queue.complete(conn, job, cfg.worker_id, {"x": 1}, []) is False
    assert conn.execute("SELECT status FROM media_job").fetchone()["status"] == "cancelled"


def test_queue_stats_view(env):
    cfg, st, conn, scratch = env
    enqueue(scratch, "GCLUB", "probe", KEY)
    with psycopg.connect(scratch["url"]) as su:
        assert su.execute("SELECT queued FROM v_media_queue_stats WHERE club_id='GCLUB'").fetchone()[0] == 1
