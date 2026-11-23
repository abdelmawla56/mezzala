#!/usr/bin/env node
/**
 * scripts/ensure-bucket.mjs
 * Idempotently creates the MinIO/S3 media bucket and enables versioning.
 * Uses the S3 API (CreateBucket + PutBucketVersioning) — no mkdir, no mc.
 *
 * Env vars (resolved from .env.local if present):
 *   S3_ENDPOINT_URL   e.g. http://localhost:9000  (omit for real AWS)
 *   S3_BUCKET         bucket name
 *   S3_ACCESS_KEY     access key / MINIO_ROOT_USER
 *   S3_SECRET_KEY     secret key / MINIO_ROOT_PASSWORD
 *   S3_REGION         default eu-central-1
 *   S3_FORCE_PATH_STYLE  set to "true" for MinIO
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutBucketPolicyCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local if present
const envPath = path.resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const endpoint = process.env.S3_ENDPOINT_URL;
const bucket   = process.env.S3_BUCKET    || "mezzala-media";
const access   = process.env.S3_ACCESS_KEY;
const secret   = process.env.S3_SECRET_KEY;
const region   = process.env.S3_REGION    || "eu-central-1";
const force    = (process.env.S3_FORCE_PATH_STYLE || "true").toLowerCase() === "true";

if (!access || !secret) {
  console.error("S3_ACCESS_KEY / S3_SECRET_KEY are not set");
  process.exit(1);
}

const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId: access, secretAccessKey: secret },
  forcePathStyle: force,
});

async function run() {
  console.log(`ensure-bucket: target ${endpoint ?? "AWS"} bucket=${bucket} region=${region}`);

  // 1. Create bucket (idempotent — 409 BucketAlreadyOwnedByYou is OK)
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`ensure-bucket: created bucket "${bucket}"`);
  } catch (err) {
    const code = err?.Code || err?.name || err?.code;
    if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") {
      console.log(`ensure-bucket: bucket "${bucket}" already exists — OK`);
    } else {
      throw err;
    }
  }

  // 2. Verify we can HEAD it
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`ensure-bucket: HEAD bucket OK`);

  // 3. Enable versioning
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    })
  );
  console.log(`ensure-bucket: versioning enabled`);

  console.log(`ensure-bucket: bucket "${bucket}" is ready`);
}

run().catch((err) => {
  console.error("ensure-bucket failed:", err);
  process.exit(1);
});
