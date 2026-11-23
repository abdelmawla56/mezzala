#!/usr/bin/env node
/**
 * scripts/storage-smoke.mjs
 * End-to-end media storage & worker smoke test with real output (no mocks).
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env.local");

// Load .env.local
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

import {
  startMultipart,
  presignPart,
  completeMultipart,
  listParts,
  head,
  presignGet,
} from "../lib/storage/s3.ts";
import { enqueue, getJob, listJobs } from "../lib/media/jobs.ts";
import { withTenant } from "../lib/db/with-tenant.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_URL_OWNER = process.env.DATABASE_URL_OWNER;

const appPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const ownerPool = new pg.Pool({ connectionString: DATABASE_URL_OWNER, max: 2 });

const CLUB = "GCLUB";
const MATCH_ID = 101;
const ASSET_ID = Date.now() % 100000;
const ASSET_REF = `smoke_asset_${ASSET_ID}`;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log("=================================================");
  console.log("=== STORAGE & MEDIA WORKER SMOKE TEST (TASK 2) ===");
  console.log("=================================================");

  // 1. Generate a 20-second test video with ffmpeg
  console.log("\n-> 1. Generating 20-second test video with ffmpeg...");
  const tempVideoPath = path.resolve(__dirname, `smoke_test_${ASSET_ID}.mp4`);
  const wslVideoPath = tempVideoPath.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);

  try {
    // Generate ~12-14 MB video: 20s, 640x360, 30fps, 5.5 Mbps
    // Try via wsl directly or docker
    let generated = false;
    try {
      execSync(`wsl ffmpeg -y -f lavfi -i testsrc=duration=20:size=640x360:rate=30 -c:v libx264 -b:v 5500k -pix_fmt yuv420p "${wslVideoPath}" 2>&1`, { stdio: "pipe" });
      generated = true;
    } catch {
      // Fallback to worker docker image
      execSync(`wsl docker run --rm -v "${path.dirname(wslVideoPath)}:/out" mezzala-worker ffmpeg -y -f lavfi -i testsrc=duration=20:size=640x360:rate=30 -c:v libx264 -b:v 5500k -pix_fmt yuv420p "/out/${path.basename(wslVideoPath)}" 2>&1`, { stdio: "pipe" });
      generated = true;
    }

    if (!existsSync(tempVideoPath)) {
      throw new Error(`Failed to generate video at ${tempVideoPath}`);
    }

    const videoBytes = readFileSync(tempVideoPath);
    console.log(`PASS: Generated 20s test video: ${videoBytes.length} bytes (${(videoBytes.length / (1024 * 1024)).toFixed(2)} MB)`);

    const trueSha256 = crypto.createHash("sha256").update(videoBytes).digest("hex");
    console.log(`   Video true SHA256: ${trueSha256}`);

    // 2. Upload video in at least 3 parts using presigned part URLs
    console.log("\n-> 2. Uploading video via multipart presigned URLs in 3 parts...");
    const { uploadId, key } = await startMultipart(CLUB, MATCH_ID, ASSET_ID, ".mp4");
    console.log(`   Initiated multipart upload: uploadId=${uploadId.slice(0, 30)}... key=${key}`);

    // S3 requires >= 5MB for non-final parts
    const partMin = 5 * 1024 * 1024 + 1024; // 5MB + 1KB
    if (videoBytes.length < partMin * 2) {
      throw new Error(`Video too small for 3 S3 parts: ${videoBytes.length} bytes (need >= ${partMin * 2})`);
    }

    const part1 = videoBytes.subarray(0, partMin);
    const part2 = videoBytes.subarray(partMin, partMin * 2);
    const part3 = videoBytes.subarray(partMin * 2);
    const partBuffers = [part1, part2, part3];

    const completedParts = [];
    for (let i = 0; i < partBuffers.length; i++) {
      const partNum = i + 1;
      const partUrl = await presignPart(CLUB, key, uploadId, partNum, 3600);
      const putRes = await fetch(partUrl, {
        method: "PUT",
        body: partBuffers[i],
      });
      if (putRes.status !== 200) {
        throw new Error(`Upload part ${partNum} failed with status ${putRes.status}`);
      }
      const etag = putRes.headers.get("etag");
      completedParts.push({ PartNumber: partNum, ETag: etag });
      console.log(`   Uploaded part ${partNum}/3: ${partBuffers[i].length} bytes, ETag=${etag}`);
    }

    const partsList = await listParts(CLUB, key, uploadId);
    console.log(`   Listed in-progress parts: ${partsList.length} parts found on storage`);

    // 3. Complete multipart upload
    console.log("\n-> 3. Completing multipart upload...");
    await completeMultipart(CLUB, key, uploadId, completedParts);
    console.log("PASS: Completed multipart upload successfully.");

    // 4. HEAD the completed object
    console.log("\n-> 4. HEAD completed object...");
    const headObj = await head(key);
    console.log(`PASS: HEAD ${key}: size=${headObj.contentLength} bytes, ETag=${headObj.etag}`);
    if (headObj.contentLength !== videoBytes.length) {
      throw new Error(`Size mismatch: expected ${videoBytes.length}, got ${headObj.contentLength}`);
    }

    // 5. Ensure baseline match and tenant context exist
    const oc = await ownerPool.connect();
    try {
      await oc.query("INSERT INTO tenant (id, name) VALUES ('GCLUB', 'Golden Club') ON CONFLICT DO NOTHING");
      await oc.query("INSERT INTO tenant (id, name) VALUES ('TEST-000', 'Test Tenant') ON CONFLICT DO NOTHING");
      await oc.query(
        "INSERT INTO tg_match (id, club_id, code) VALUES ($1, $2, 'SMOKE_TEST_MATCH') ON CONFLICT (id) DO NOTHING",
        [MATCH_ID, CLUB]
      );
    } finally {
      oc.release();
    }

    // 6. Enqueue probe, hash, proxy, and thumbnails jobs
    console.log("\n-> 5. Enqueueing media jobs (probe, hash, proxy, thumbnails)...");
    const probeJob = await enqueue(CLUB, "probe", ASSET_REF, { key });
    const hashJob = await enqueue(CLUB, "hash", ASSET_REF, { key, expected_sha256: trueSha256 });
    const proxyJob = await enqueue(CLUB, "proxy", ASSET_REF, { key, height: 720 });
    const thumbJob = await enqueue(CLUB, "thumbnails", ASSET_REF, { key, interval_s: 5, duration_ms: 20000 });

    console.log(`   Enqueued probe job: id=${probeJob.id}`);
    console.log(`   Enqueued hash job: id=${hashJob.id}`);
    console.log(`   Enqueued proxy job: id=${proxyJob.id}`);
    console.log(`   Enqueued thumbnails job: id=${thumbJob.id}`);

    // 7. Start the worker container
    console.log("\n-> 6. Starting media worker via docker compose up -d --build worker...");
    execSync("wsl docker compose -f /mnt/c/Users/YOUSSEF/Desktop/clip/mezzala/infra/docker-compose.yml up -d --build worker", { stdio: "inherit" });

    // 8. Poll until all four succeed
    console.log("\n-> 7. Polling jobs until all four succeed...");
    const jobIds = [probeJob.id, hashJob.id, proxyJob.id, thumbJob.id];
    const finishedJobs = new Map();

    const startTime = Date.now();
    const timeoutMs = 120000; // 2 minutes timeout

    while (finishedJobs.size < jobIds.length) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Timeout waiting for media jobs after ${timeoutMs / 1000}s`);
      }

      for (const id of jobIds) {
        if (finishedJobs.has(id)) continue;
        const j = await getJob(CLUB, id);
        if (j.status === "succeeded") {
          finishedJobs.set(id, j);
          console.log(`   [JOB DONE] kind=${j.kind} id=${j.id} attempts=${j.attempts}`);
        } else if (j.status === "failed") {
          throw new Error(`Job ${id} (${j.kind}) failed: ${j.last_error}`);
        }
      }

      if (finishedJobs.size < jobIds.length) {
        await sleep(2000);
      }
    }

    const finishedProbe = finishedJobs.get(probeJob.id);
    const finishedHash = finishedJobs.get(hashJob.id);
    const finishedProxy = finishedJobs.get(proxyJob.id);
    const finishedThumb = finishedJobs.get(thumbJob.id);

    // 9. Assertions
    console.log("\n-> 8. Verifying job execution and media contracts...");

    // Assertion 1: probe duration is within 2% of 20 s (19600 to 20400 ms)
    const durMs = finishedProbe.result?.duration_ms;
    const durDelta = Math.abs(durMs - 20000);
    const durPct = (durDelta / 20000) * 100;
    if (durDelta > 400) {
      throw new Error(`Probe duration ${durMs}ms exceeds 2% delta (delta=${durDelta}ms, ${durPct.toFixed(2)}%)`);
    }
    console.log(`PASS: Probe duration is ${durMs}ms (within 2% of 20,000ms: delta=${durDelta}ms, ${durPct.toFixed(2)}%)`);

    // Assertion 2: hash matches
    if (finishedHash.result?.matches_expected !== true || finishedHash.result?.sha256 !== trueSha256) {
      throw new Error(`Hash mismatch: expected ${trueSha256}, got ${finishedHash.result?.sha256}`);
    }
    console.log(`PASS: Hash matches true video SHA256: ${finishedHash.result.sha256}`);

    // Assertion 3: proxy keyframe_max_gap_s <= 1.2
    const keyframeGap = finishedProxy.result?.keyframe_max_gap_s;
    if (typeof keyframeGap !== "number" || keyframeGap > 1.2) {
      throw new Error(`Proxy keyframe_max_gap_s ${keyframeGap} is > 1.2`);
    }
    console.log(`PASS: Proxy keyframe_max_gap_s is ${keyframeGap} (<= 1.2)`);

    // Assertion 4: at least 1 thumbnail
    const thumbCount = finishedThumb.result?.count;
    if (typeof thumbCount !== "number" || thumbCount < 1) {
      throw new Error(`Thumbnail count is ${thumbCount} (expected >= 1)`);
    }
    console.log(`PASS: Generated ${thumbCount} thumbnail(s) (>= 1)`);

    // Assertion 5: media_derivative rows exist and each storage_key HEADs OK
    console.log("\n-> 9. Verifying media_derivative rows and S3 objects...");
    const derivatives = await withTenant(appPool, CLUB, async (c) => {
      const { rows } = await c.query(
        "SELECT id, kind, storage_key, bytes, sha256 FROM media_derivative WHERE club_id = $1 AND asset_ref = $2",
        [CLUB, ASSET_REF]
      );
      return rows;
    });

    if (derivatives.length < 2) {
      throw new Error(`Expected at least 2 derivatives (proxy + thumbs), got ${derivatives.length}`);
    }
    console.log(`PASS: Found ${derivatives.length} media_derivative rows in database.`);

    for (const d of derivatives) {
      const dHead = await head(d.storage_key);
      if (!dHead || dHead.contentLength <= 0) {
        throw new Error(`HEAD failed or empty for derivative ${d.storage_key}`);
      }
      console.log(`   HEAD OK: [${d.kind}] ${d.storage_key} (${dHead.contentLength} bytes)`);
    }

    // Assertion 6: a GCLUB job with a TEST-000 key fails permanently
    console.log("\n-> 10. Testing cross-tenant storage key isolation (GCLUB job with TEST-000 key)...");
    const badJob = await enqueue(CLUB, "probe", ASSET_REF, { key: "TEST-000/999/888/original.mp4" }, `bad_key_${Date.now()}`);
    let badFinished = null;
    for (let i = 0; i < 30; i++) {
      badFinished = await getJob(CLUB, badJob.id);
      if (badFinished.status === "failed") break;
      await sleep(1000);
    }
    if (badFinished.status !== "failed" || !badFinished.last_error?.includes("tenant prefix")) {
      throw new Error(`Expected bad tenant job to fail permanently, got status=${badFinished.status}, error=${badFinished.last_error}`);
    }
    console.log(`PASS: Cross-tenant key job failed permanently: status=${badFinished.status}, error='${badFinished.last_error}'`);

    // Assertion 7: the app role cannot read another club's jobs
    console.log("\n-> 11. Testing tenant isolation: TEST-000 cannot read GCLUB jobs...");
    const crossJobRead = await withTenant(appPool, "TEST-000", async (c) => {
      const { rows } = await c.query("SELECT * FROM media_job WHERE id = $1", [probeJob.id]);
      return rows;
    });
    if (crossJobRead.length > 0) {
      throw new Error(`Tenant leak: TEST-000 was able to read GCLUB media_job ${probeJob.id}!`);
    }
    console.log("PASS: TEST-000 context returned 0 rows for GCLUB media_job (RLS isolated).");

    // Assertion 8: presignGet(..., 2) returns 403 after 3 seconds
    console.log("\n-> 12. Testing presignGet URL expiration (2s expiry fetched after 3.1s)...");
    const shortUrl = await presignGet(key, 2);
    // Fetch immediately to ensure valid
    const okRes = await fetch(shortUrl);
    if (okRes.status !== 200) {
      throw new Error(`Immediate presigned GET failed: status=${okRes.status}`);
    }
    console.log(`   Immediate fetch (< 2s): ${okRes.status} OK`);
    await sleep(3100);
    const expRes = await fetch(shortUrl);
    if (expRes.status !== 403) {
      throw new Error(`Expected expired presigned GET to return 403, got ${expRes.status}`);
    }
    console.log(`PASS: Expired fetch (> 2s): ${expRes.status} Forbidden.`);

    // Assertion 9: presignGet(..., 601) throws
    console.log("\n-> 13. Testing presignGet hard maximum rejection (> 600s)...");
    let didThrow = false;
    try {
      await presignGet(key, 601);
    } catch (err) {
      didThrow = true;
      console.log(`PASS: presignGet(key, 601) threw as expected: '${err.message}'`);
    }
    if (!didThrow) {
      throw new Error("presignGet(key, 601) did NOT throw!");
    }

    console.log("\n=================================================");
    console.log("=== ALL STORAGE SMOKE TEST CHECKS PASSED ===");
    console.log("=================================================");
  } finally {
    // Clean up temporary local video file
    if (existsSync(tempVideoPath)) {
      try { unlinkSync(tempVideoPath); } catch {}
    }
    await appPool.end();
    await ownerPool.end();
  }
}

run().catch((err) => {
  console.error("Storage smoke test FAILED:", err);
  process.exit(1);
});
