"""ffprobe / ffmpeg wrappers. Pure builders and parsers are separate so they can be unit tested."""
import json
import math
import subprocess
from fractions import Fraction

from .storage import PermanentError


def run(cmd: list[str], secret: str | None = None, timeout: int | None = None) -> subprocess.CompletedProcess:
    """Run a tool. The presigned URL is a credential: it never reaches logs or error text."""
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        err = (p.stderr or "")[-600:]
        if secret:
            err = err.replace(secret, "<url>")
        raise RuntimeError(f"{cmd[0]} exited {p.returncode}: {err.strip()}")
    return p


def _fps(s: str | None) -> float | None:
    try:
        f = Fraction(s)
        return round(float(f), 3) if f > 0 else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def parse_probe(doc: dict, keyframe_times: list[float]) -> dict:
    streams = doc.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if v is None:
        raise PermanentError("no video stream")
    fmt = doc.get("format", {})
    dur = float(fmt.get("duration") or v.get("duration") or 0)
    ts = sorted(set(keyframe_times))
    gaps = [b - a_ for a_, b in zip(ts, ts[1:])]
    return {
        "duration_ms": int(round(dur * 1000)),
        "width": v.get("width"), "height": v.get("height"),
        "fps": _fps(v.get("avg_frame_rate")) or _fps(v.get("r_frame_rate")),
        "video_codec": v.get("codec_name"), "audio_codec": a.get("codec_name") if a else None,
        "bit_rate": int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        "size_bytes": int(fmt["size"]) if fmt.get("size") else None,
        "container": fmt.get("format_name"),
        "keyframe_max_gap_s": round(max(gaps), 3) if gaps else None,
        "keyframe_samples": len(ts),
    }


def probe(ffprobe: str, url: str) -> dict:
    doc = json.loads(run([ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", url], url, 300).stdout)
    kf = run([ffprobe, "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries",
              "frame=pts_time", "-of", "csv=p=0", "-read_intervals", "%+120", url], url, 300).stdout
    times = []
    for line in kf.splitlines():
        try:
            times.append(float(line.strip().rstrip(",")))
        except ValueError:
            pass
    return parse_probe(doc, times)


def proxy_cmd(ffmpeg: str, src: str, out: str, height: int, keyframe_s: float) -> list[str]:
    return [ffmpeg, "-nostdin", "-y", "-v", "error", "-i", src,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", f"scale=-2:'min({height},ih)'",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-force_key_frames", f"expr:gte(t,n_forced*{keyframe_s})", "-sc_threshold", "0",
            "-c:a", "aac", "-b:a", "96k", "-ac", "2",
            "-movflags", "+faststart", out]


def thumb_times(duration_s: float, interval: int, limit: int) -> list[int]:
    if duration_s <= 0:
        return [0]
    n = min(limit, max(1, math.ceil(duration_s / interval)))
    return [min(i * interval, max(0, int(duration_s) - 1)) for i in range(n)]


def thumb_cmd(ffmpeg: str, src: str, t: int, out: str) -> list[str]:
    return [ffmpeg, "-nostdin", "-y", "-v", "error", "-ss", str(t), "-i", src, "-frames:v", "1",
            "-vf", "scale=320:-2", "-q:v", "5", out]
