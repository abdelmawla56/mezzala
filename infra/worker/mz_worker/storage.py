import hashlib
from typing import Iterator

import boto3
from botocore.config import Config as BotoConfig

from .config import Config


class PermanentError(Exception):
    """Retrying cannot help (bad payload, key outside the tenant prefix, unsupported kind)."""


def check_key(club_id: str, key: str) -> str:
    """Every object the worker reads or writes lives under '<club_id>/'. Defence in depth: the
    database row-level policy already scopes jobs, this scopes the bytes."""
    if not isinstance(key, str) or not key or key.startswith("/") or ".." in key.split("/"):
        raise PermanentError("invalid storage key")
    if not key.startswith(f"{club_id}/"):
        raise PermanentError("storage key is outside the job's tenant prefix")
    return key


class Storage:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.s3 = boto3.client(
            "s3", region_name=cfg.region, endpoint_url=cfg.endpoint_url,
            config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path" if cfg.endpoint_url else "auto"},
                              retries={"max_attempts": 5, "mode": "standard"}))

    def presign_get(self, key: str, seconds: int = 3600) -> str:
        return self.s3.generate_presigned_url("get_object", Params={"Bucket": self.cfg.bucket, "Key": key}, ExpiresIn=seconds)

    def head(self, key: str) -> dict:
        return self.s3.head_object(Bucket=self.cfg.bucket, Key=key)

    def sha256(self, key: str, chunk: int = 8 * 1024 * 1024) -> tuple[str, int]:
        body = self.s3.get_object(Bucket=self.cfg.bucket, Key=key)["Body"]
        h, n = hashlib.sha256(), 0
        for part in iter(lambda: body.read(chunk), b""):
            h.update(part)
            n += len(part)
        return h.hexdigest(), n

    def upload_file(self, path: str, key: str, club_id: str, content_type: str) -> None:
        extra = {"ContentType": content_type}
        kms = self.cfg.kms_keys.get(club_id)
        if kms:
            extra.update(ServerSideEncryption="aws:kms", SSEKMSKeyId=kms)
        self.s3.upload_file(path, self.cfg.bucket, key, ExtraArgs=extra)
