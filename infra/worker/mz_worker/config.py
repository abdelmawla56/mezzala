import json
import os
import socket
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Config:
    database_url: str
    bucket: str
    region: str = "eu-central-1"
    endpoint_url: str | None = None          # set for MinIO / moto, unset for AWS
    kms_keys: dict = field(default_factory=dict)   # {"GCLUB": "arn:aws:kms:..."}; empty in dev
    worker_id: str = f"{socket.gethostname()}-{os.getpid()}"
    poll_interval: float = 2.0
    lease_seconds: int = 120
    heartbeat_seconds: int = 20
    proxy_height: int = 720
    keyframe_seconds: float = 1.0            # short keyframe interval: closer, faster seeking
    thumb_interval: int = 60
    thumb_max: int = 240
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"

    @classmethod
    def from_env(cls) -> "Config":
        e = os.environ
        return cls(
            database_url=e["DATABASE_URL_WORKER"],
            bucket=e["S3_BUCKET"],
            region=e.get("AWS_REGION", "eu-central-1"),
            endpoint_url=e.get("S3_ENDPOINT_URL") or None,
            kms_keys=json.loads(e.get("MZ_TENANT_KMS_KEYS", "{}") or "{}"),
            poll_interval=float(e.get("WORKER_POLL_SECONDS", 2)),
            lease_seconds=int(e.get("WORKER_LEASE_SECONDS", 120)),
            proxy_height=int(e.get("PROXY_HEIGHT", 720)),
            keyframe_seconds=float(e.get("PROXY_KEYFRAME_SECONDS", 1)),
            thumb_interval=int(e.get("THUMB_INTERVAL_SECONDS", 60)),
            thumb_max=int(e.get("THUMB_MAX", 240)),
        )
