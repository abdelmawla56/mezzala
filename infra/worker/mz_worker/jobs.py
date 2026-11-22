import hashlib
import os
import tempfile

from . import media
from .config import Config
from .storage import PermanentError, Storage, check_key


def _file_sha(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def _source(job: dict, st: Storage) -> tuple[str, str]:
    key = check_key(job["club_id"], (job["payload"] or {}).get("key"))
    try:
        st.head(key)
    except Exception as e:                       # missing object: transient (upload may still be finishing)
        raise RuntimeError(f"source object not readable: {type(e).__name__}") from e
    return key, st.presign_get(key)


def do_probe(job, cfg: Config, st: Storage):
    _, url = _source(job, st)
    return media.probe(cfg.ffprobe, url), []


def do_hash(job, cfg: Config, st: Storage):
    key, _ = _source(job, st)
    digest, n = st.sha256(key)
    expected = (job["payload"] or {}).get("expected_sha256")
    return {"sha256": digest, "bytes": n, "matches_expected": None if not expected else digest == expected.lower()}, []


def do_proxy(job, cfg: Config, st: Storage):
    _, url = _source(job, st)
    p = job["payload"] or {}
    height = int(p.get("height") or cfg.proxy_height)
    out_key = f"{job['club_id']}/derived/{job['asset_ref']}/proxy/{job['id']}.mp4"
    with tempfile.TemporaryDirectory(prefix="mzproxy") as d:
        out = os.path.join(d, "proxy.mp4")
        media.run(media.proxy_cmd(cfg.ffmpeg, url, out, height, cfg.keyframe_seconds), url)
        meta = media.probe(cfg.ffprobe, out)
        digest, size = _file_sha(out), os.path.getsize(out)
        st.upload_file(out, out_key, job["club_id"], "video/mp4")
    deriv = {"kind": "proxy", "storage_key": out_key, "bytes": size, "sha256": digest,
             "meta": {k: meta[k] for k in ("duration_ms", "width", "height", "fps", "video_codec", "keyframe_max_gap_s")}}
    return {"proxy_key": out_key, "keyframe_max_gap_s": meta["keyframe_max_gap_s"], "height": meta["height"]}, [deriv]


def do_thumbnails(job, cfg: Config, st: Storage):
    _, url = _source(job, st)
    p = job["payload"] or {}
    interval = int(p.get("interval_s") or cfg.thumb_interval)
    dur = float(p["duration_ms"]) / 1000 if p.get("duration_ms") else float(
        media.run([cfg.ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", url], url).stdout.strip() or 0)
    derivs = []
    with tempfile.TemporaryDirectory(prefix="mzthumb") as d:
        for i, t in enumerate(media.thumb_times(dur, interval, cfg.thumb_max)):
            out = os.path.join(d, f"{i:05d}.jpg")
            media.run(media.thumb_cmd(cfg.ffmpeg, url, t, out), url)
            key = f"{job['club_id']}/derived/{job['asset_ref']}/thumbs/{job['id']}/{i:05d}.jpg"
            st.upload_file(out, key, job["club_id"], "image/jpeg")
            derivs.append({"kind": "thumbnail", "storage_key": key, "bytes": os.path.getsize(out),
                           "sha256": _file_sha(out), "meta": {"t_s": t}})
    return {"count": len(derivs), "interval_s": interval}, derivs


HANDLERS = {"probe": do_probe, "hash": do_hash, "proxy": do_proxy, "thumbnails": do_thumbnails}


def run_job(job: dict, cfg: Config, st: Storage):
    h = HANDLERS.get(job["kind"])
    if h is None:
        raise PermanentError(f"unsupported job kind {job['kind']}")
    return h(job, cfg, st)
