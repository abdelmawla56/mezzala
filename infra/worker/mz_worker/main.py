import signal
import threading
import time

from . import queue
from .config import Config
from .jobs import run_job
from .log import log, metric
from .storage import PermanentError, Storage


def run_once(cfg: Config, conn, st: Storage) -> bool:
    """Claim and process at most one job. Returns True if a job was claimed."""
    job = queue.claim(conn, cfg.worker_id)
    if job is None:
        return False
    t0 = time.time()
    log("job.start", job=job["id"], kind=job["kind"], club=job["club_id"], attempt=job["attempts"])
    try:
        with queue.Heartbeat(cfg.database_url, job["id"], cfg.worker_id, cfg.heartbeat_seconds):
            result, derivs = run_job(job, cfg, st)
        ok = queue.complete(conn, job, cfg.worker_id, result, derivs)
        log("job.done" if ok else "job.lost_lease", job=job["id"], kind=job["kind"], seconds=round(time.time() - t0, 2))
        metric("JobsSucceeded" if ok else "JobsLostLease", 1, kind=job["kind"])
    except PermanentError as e:
        queue.fail(conn, job, cfg.worker_id, str(e), True)
        log("job.failed", job=job["id"], kind=job["kind"], permanent=True, error=str(e))
        metric("JobsFailed", 1, kind=job["kind"])
    except Exception as e:
        status = queue.fail(conn, job, cfg.worker_id, f"{type(e).__name__}: {e}", False)
        log("job.error", job=job["id"], kind=job["kind"], status=status, error=f"{type(e).__name__}: {e}"[:500])
        if status == "failed":
            metric("JobsFailed", 1, kind=job["kind"])
    return True


def main() -> None:
    cfg = Config.from_env()
    st = Storage(cfg)
    stop = threading.Event()
    for s in (signal.SIGTERM, signal.SIGINT):
        signal.signal(s, lambda *_: stop.set())
    conn = queue.connect(cfg.database_url)
    log("worker.start", worker=cfg.worker_id, bucket=cfg.bucket)
    last_stats = 0.0
    while not stop.is_set():
        n = queue.reap(conn, cfg.lease_seconds)
        if n:
            log("worker.reaped", jobs=n)
        busy = run_once(cfg, conn, st)
        if time.time() - last_stats > 30:
            metric("QueueLagSeconds", queue.queue_lag_seconds(conn), "Seconds")
            last_stats = time.time()
        if not busy:
            stop.wait(cfg.poll_interval)
    log("worker.stop", worker=cfg.worker_id)
