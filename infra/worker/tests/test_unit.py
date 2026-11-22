import pytest
from mz_worker import media
from mz_worker.storage import PermanentError, check_key


def test_key_must_sit_under_tenant_prefix():
    assert check_key("GCLUB", "GCLUB/m1/a1/original.mp4")
    for bad in ("TEST-000/m1/original.mp4", "/GCLUB/x", "GCLUB/../TEST-000/x", "", None, "GCLUBX/x"):
        with pytest.raises(PermanentError):
            check_key("GCLUB", bad)


def test_parse_probe():
    doc = {"streams": [{"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
                        "avg_frame_rate": "30000/1001"}, {"codec_type": "audio", "codec_name": "aac"}],
           "format": {"duration": "5400.5", "bit_rate": "4000000", "size": "123", "format_name": "mov,mp4"}}
    r = media.parse_probe(doc, [0.0, 2.0, 9.0, 10.0])
    assert r["duration_ms"] == 5400500 and r["fps"] == 29.97 and r["keyframe_max_gap_s"] == 7.0
    assert r["audio_codec"] == "aac" and r["keyframe_samples"] == 4


def test_probe_without_video_is_permanent():
    with pytest.raises(PermanentError):
        media.parse_probe({"streams": [{"codec_type": "audio"}], "format": {}}, [])


def test_proxy_command_forces_short_keyframes_and_faststart():
    cmd = media.proxy_cmd("ffmpeg", "http://x", "/tmp/o.mp4", 720, 1.0)
    assert "expr:gte(t,n_forced*1.0)" in cmd and "+faststart" in cmd and "libx264" in cmd


def test_thumb_times_capped_and_in_range():
    assert media.thumb_times(10, 60, 240) == [0]
    t = media.thumb_times(5400, 60, 240)
    assert len(t) == 90 and t[-1] <= 5399
    assert len(media.thumb_times(100000, 60, 240)) == 240


def test_secret_url_never_in_error():
    with pytest.raises(RuntimeError) as e:
        media.run(["sh", "-c", "echo SECRET-URL >&2; exit 3"], "SECRET-URL")
    assert "SECRET-URL" not in str(e.value) and "<url>" in str(e.value)
