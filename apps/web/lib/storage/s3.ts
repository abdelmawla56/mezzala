// apps/web/lib/storage/s3.ts
// Standalone S3/MinIO multipart-upload client.  No HTTP route code, no auth wiring.
// All presigned URLs are logged at a plain "generated presigned url" message WITHOUT the URL itself.
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  ListPartsCommand,
  HeadObjectCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── env loader ──────────────────────────────────────────────────────────────
function loadEnvIfNeeded() {
  if (process.env.S3_BUCKET) return; // already loaded (e.g. Next.js injected)
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env.local"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
    break;
  }
}

// ─── constants ───────────────────────────────────────────────────────────────
const PRESIGN_GET_MAX_SECONDS = 600;

// ─── key guard ───────────────────────────────────────────────────────────────
function checkKey(clubPrefix: string, key: string): void {
  if (!key || key.startsWith("/") || key.includes("..")) {
    throw new Error(`S3: invalid storage key: ${key}`);
  }
  if (!key.startsWith(`${clubPrefix}/`)) {
    throw new Error(
      `S3: key "${key}" is outside the caller's club prefix "${clubPrefix}/"`
    );
  }
}

// ─── canonical key builder ───────────────────────────────────────────────────
export function objectKey(
  clubId: string,
  matchId: string | number,
  assetId: string | number,
  ext: string
): string {
  const e = ext.startsWith(".") ? ext : `.${ext}`;
  return `${clubId}/${matchId}/${assetId}/original${e}`;
}

// ─── client factory ──────────────────────────────────────────────────────────
let _client: S3Client | null = null;
let _bucket: string | null = null;

export function getS3Client(): { client: S3Client; bucket: string } {
  if (_client && _bucket) return { client: _client, bucket: _bucket };
  loadEnvIfNeeded();
  const endpoint = process.env.S3_ENDPOINT_URL;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  const region = process.env.S3_REGION ?? "eu-central-1";
  const forcePathStyle =
    (process.env.S3_FORCE_PATH_STYLE ?? "false").toLowerCase() === "true" ||
    !!endpoint;

  if (!bucket) throw new Error("S3_BUCKET is not set");
  if (!accessKeyId || !secretAccessKey)
    throw new Error("S3_ACCESS_KEY / S3_SECRET_KEY are not set");

  _client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle,
  });
  _bucket = bucket;
  return { client: _client, bucket: _bucket };
}

// ─── public API ──────────────────────────────────────────────────────────────

/** Start a multipart upload. Returns the UploadId. */
export async function startMultipart(
  clubId: string,
  matchId: string | number,
  assetId: string | number,
  ext: string
): Promise<{ uploadId: string; key: string }> {
  const key = objectKey(clubId, matchId, assetId, ext);
  const { client, bucket } = getS3Client();
  const res = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key })
  );
  if (!res.UploadId) throw new Error("S3: CreateMultipartUpload returned no UploadId");
  return { uploadId: res.UploadId, key };
}

/** Presign a single-part upload URL (valid up to 1 hour = 3600 s). */
export async function presignPart(
  clubId: string,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn = 3600
): Promise<string> {
  checkKey(clubId, key);
  const exp = Math.min(expiresIn, 3600);
  const { client, bucket } = getS3Client();
  const url = await getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: exp }
  );
  // Never log the presigned URL itself
  console.log(`[s3] generated presigned part upload url key=${key} part=${partNumber} expires=${exp}s`);
  return url;
}

/** Complete a multipart upload. parts = [{PartNumber, ETag}]. */
export async function completeMultipart(
  clubId: string,
  key: string,
  uploadId: string,
  parts: Array<{ PartNumber: number; ETag: string }>
): Promise<void> {
  checkKey(clubId, key);
  const { client, bucket } = getS3Client();
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    })
  );
}

/** List parts already uploaded for an in-progress multipart upload. */
export async function listParts(
  clubId: string,
  key: string,
  uploadId: string
): Promise<Array<{ PartNumber: number; ETag: string; Size: number }>> {
  checkKey(clubId, key);
  const { client, bucket } = getS3Client();
  const res = await client.send(
    new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId })
  );
  return (res.Parts ?? []).map((p) => ({
    PartNumber: p.PartNumber ?? 0,
    ETag: p.ETag ?? "",
    Size: p.Size ?? 0,
  }));
}

/** HEAD an object — returns metadata (ContentLength, ETag, LastModified, …). */
export async function head(
  key: string
): Promise<{ contentLength: number; etag: string; lastModified: Date }> {
  const { client, bucket } = getS3Client();
  const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return {
    contentLength: res.ContentLength ?? 0,
    etag: res.ETag ?? "",
    lastModified: res.LastModified ?? new Date(0),
  };
}

/**
 * Presign a GET URL.
 * @param key     Object key (not club-prefixed guard: caller is responsible).
 * @param seconds Expiry, hard maximum 600. Throws if > 600.
 */
export async function presignGet(key: string, seconds: number): Promise<string> {
  if (seconds > PRESIGN_GET_MAX_SECONDS) {
    throw new Error(
      `presignGet: requested expiry ${seconds}s exceeds hard maximum ${PRESIGN_GET_MAX_SECONDS}s`
    );
  }
  const { client, bucket } = getS3Client();
  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: seconds }
  );
  console.log(`[s3] generated presigned get url key=${key} expires=${seconds}s`);
  return url;
}

/** Abort an in-progress multipart upload. */
export async function abort(
  clubId: string,
  key: string,
  uploadId: string
): Promise<void> {
  checkKey(clubId, key);
  const { client, bucket } = getS3Client();
  await client.send(
    new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })
  );
}
