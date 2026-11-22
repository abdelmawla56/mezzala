#!/bin/sh
# Creates the private media bucket with versioning. Idempotent.
set -eu
mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
mc mb --ignore-existing "local/$S3_BUCKET"
mc anonymous set none "local/$S3_BUCKET"
mc version enable "local/$S3_BUCKET"
echo "bucket $S3_BUCKET ready"
