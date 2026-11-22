#!/usr/bin/env node
/**
 * video-check.mjs
 * Validates media asset handling, tenant constraints, and worker derivative isolation.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env.local");

function loadEnv(filePath) {
  if (!existsSync(filePath)) throw new Error(`Missing .env.local at ${filePath}`);
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv(envPath);

const { DATABASE_URL, DATABASE_URL_OWNER } = process.env;
const appPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const ownerPool = new pg.Pool({ connectionString: DATABASE_URL_OWNER, max: 2 });

async function withTenant(pool, clubId, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.club_id', $1, true)", [clubId]);
    const res = await fn(c);
    await c.query("COMMIT");
    return res;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

async function run() {
  console.log("=== Running video-check.mjs ===");
  const ownerClient = await ownerPool.connect();
  let matchId;
  try {
    const matchRes = await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('GCLUB', 'VIDEO_CHECK_FIXTURE', CURRENT_DATE, 'VidHome', 'VidAway') RETURNING id"
    );
    matchId = matchRes.rows[0].id;

    await withTenant(appPool, "GCLUB", async (c) => {
      // Create media asset
      const assetRes = await c.query(
        "INSERT INTO media_asset (club_id, match_id, filename, s3_key, bytes, duration_ms, upload_state) VALUES ('GCLUB', $1, 'match.mp4', 'raw/match.mp4', 1048576, 60000, 'ready') RETURNING id",
        [matchId]
      );
      const assetId = assetRes.rows[0].id;

      const { rows } = await c.query(
        "SELECT id, filename, s3_key, upload_state FROM media_asset WHERE id = $1",
        [assetId]
      );
      if (rows.length !== 1 || rows[0].filename !== "match.mp4") {
        throw new Error("Failed to query media asset");
      }
      console.log("PASS: media_asset query within tenant verified");
    });

    // Verify mz_app CANNOT insert into media_derivative (only worker can)
    let blocked = false;
    try {
      await withTenant(appPool, "GCLUB", async (c) => {
        await c.query(
          "INSERT INTO media_derivative (club_id, job_id, asset_ref, kind, storage_key) VALUES ('GCLUB', 1, 'ref1', 'proxy', 'key1')"
        );
      });
    } catch (err) {
      if (err.message.includes("permission denied") || err.code === "42501") {
        blocked = true;
      }
    }
    if (!blocked) {
      throw new Error("FAIL: mz_app was able to insert into media_derivative!");
    }
    console.log("PASS: mz_app INSERT into media_derivative denied as expected (worker only)");

  } finally {
    if (matchId) {
      await ownerClient.query("SET session_replication_role = 'replica'");
      await ownerClient.query("DELETE FROM media_asset WHERE match_id = $1", [matchId]);
      await ownerClient.query("DELETE FROM tg_match WHERE id = $1", [matchId]);
      await ownerClient.query("SET session_replication_role = 'origin'");
    }
    ownerClient.release();
    await appPool.end();
    await ownerPool.end();
  }
  console.log("=== video-check.mjs PASSED ===");
}

run().catch((err) => {
  console.error("video-check failed:", err);
  process.exit(1);
});
