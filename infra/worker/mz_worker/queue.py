import threading

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

CLAIM = """
UPDATE media_job j
   SET status = 'running', locked_by = %(w)s, heartbeat_at = now(),
       started_at = coalesce(j.started_at, now()), attempts = j.attempts + 1
 WHERE j.id = (SELECT id FROM media_job WHERE status = 'queued' AND run_after <= now()
                ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING j.*"""

REAP = """
UPDATE media_job
   SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
       locked_by = NULL, last_error = 'lease expired (worker died or stalled)',
       finished_at = CASE WHEN attempts >= max_attempts THEN now() END
 WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => %s)"""


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, autocommit=True, row_factory=dict_row)


def reap(conn, lease_s: int) -> int:
    return conn.execute(REAP, [lease_s]).rowcount


def claim(conn, worker_id: str):
    return conn.execute(CLAIM, {"w": worker_id}).fetchone()


def complete(conn, job: dict, worker_id: str, result: dict, derivatives: list[dict]) -> bool:
    """Result and derivatives commit together, and only if this worker still holds the lease
    (a cancelled or reaped job must not resurrect). Returns False when it lost the lease."""
    with conn.transaction():
        n = conn.execute(
            "UPDATE media_job SET status='succeeded', result=%s, finished_at=now(), locked_by=NULL, last_error=NULL "
            "WHERE id=%s AND locked_by=%s AND status='running'", [Jsonb(result), job["id"], worker_id]).rowcount
        if not n:
            return False
        for d in derivatives:
            conn.execute(
                "INSERT INTO media_derivative (club_id, job_id, asset_ref, kind, storage_key, bytes, sha256, meta) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (club_id, storage_key) DO NOTHING",
                [job["club_id"], job["id"], job["asset_ref"], d["kind"], d["storage_key"], d.get("bytes"),
                 d.get("sha256"), Jsonb(d.get("meta") or {})])
    return True


def fail(conn, job: dict, worker_id: str, error: str, permanent: bool) -> str:
    row = conn.execute(
        "UPDATE media_job SET attempts = CASE WHEN %(perm)s THEN max_attempts ELSE attempts END, "
        " status = CASE WHEN %(perm)s OR attempts >= max_attempts THEN 'failed' ELSE 'queued' END, "
        " run_after = now() + make_interval(secs => 30 * attempts * attempts), last_error = %(err)s, "
        " locked_by = NULL, finished_at = CASE WHEN %(perm)s OR attempts >= max_attempts THEN now() END "
        "WHERE id = %(id)s AND locked_by = %(w)s AND status = 'running' RETURNING status",
        {"perm": permanent, "err": error[:1000], "id": job["id"], "w": worker_id}).fetchone()
    return row["status"] if row else "lost"


def queue_lag_seconds(conn) -> int:
    r = conn.execute("SELECT coalesce(extract(epoch FROM now() - min(run_after)), 0)::int AS lag "
                     "FROM media_job WHERE status = 'queued' AND run_after <= now()").fetchone()
    return r["lag"]


class Heartbeat:
    """Keeps the lease alive while ffmpeg runs, on its own connection."""

    def __init__(self, url: str, job_id: int, worker_id: str, every: int):
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, args=(url, job_id, worker_id, every), daemon=True)

    def _run(self, url, job_id, worker_id, every):
        try:
            with psycopg.connect(url, autocommit=True) as c:
                while not self._stop.wait(every):
                    c.execute("UPDATE media_job SET heartbeat_at = now() WHERE id=%s AND locked_by=%s AND status='running'",
                              [job_id, worker_id])
        except Exception:
            pass                                   # a dead heartbeat only means the lease may expire

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join(timeout=5)
