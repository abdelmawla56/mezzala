#!/usr/bin/env node
/**
 * video-check.mjs
 * Validates media asset handling, route endpoints, and worker privilege boundary.
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
import pool from "../lib/db.ts";
const ownerPool = new pg.Pool({ connectionString: DATABASE_URL_OWNER, max: 2 });

import { GET as mediaGET } from "../app/api/media/route.ts";
import { withTenant } from "../lib/db/with-tenant.ts";
import { hashToken } from "../lib/auth.ts";

async function run() {
  console.log("=== Running video-check.mjs ===");
  const ownerClient = await ownerPool.connect();
  let matchId;
  const token = "video_check_token_123";

  try {
    const matchRes = await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('GCLUB', 'VIDEO_CHECK_FIXTURE', CURRENT_DATE, 'HomeVid', 'AwayVid') RETURNING id"
    );
    matchId = matchRes.rows[0].id;

    const userRes = await ownerClient.query("SELECT id FROM users WHERE email = 'admin@gclub.dev'");
    const userId = userRes.rows[0]?.id || 1;
    await ownerClient.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour') ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at",
      [hashToken(token), userId]
    );

    let assetId;
    await withTenant(pool, "GCLUB", async (c) => {
      // Create media asset
      const assetRes = await c.query(
        "INSERT INTO media_asset (club_id, match_id, filename, s3_key, bytes, duration_ms, upload_state) VALUES ('GCLUB', $1, 'video_fixture.mp4', 'raw/video_fixture.mp4', 104857600, 180000, 'ready') RETURNING id",
        [matchId]
      );
      assetId = assetRes.rows[0].id;
    });
    console.log("PASS: media_asset created in tenant context");

    // Test GET /api/media route handler
    const req = new Request(`http://localhost:3600/api/media?match_id=${matchId}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const res = await mediaGET(req);
    const json = await res.json();
    if (res.status !== 200 || json.rows.length !== 1 || json.rows[0].filename !== "video_fixture.mp4") {
      throw new Error(`GET /api/media failed: status=${res.status}, body=${JSON.stringify(json)}`);
    }
    console.log("PASS: GET /api/media returned asset metadata via authenticated session");

    // Privilege boundary: mz_app CANNOT insert or update media_derivative (worker-only table)
    let insertBlocked = false;
    try {
      await withTenant(pool, "GCLUB", async (c) => {
        await c.query(
          "INSERT INTO media_derivative (club_id, job_id, asset_ref, kind, storage_key) VALUES ('GCLUB', 1, 'ref1', 'proxy', 'key1')"
        );
      });
    } catch (err) {
      if (err.message.includes("permission denied") || err.code === "42501") {
        insertBlocked = true;
      }
    }
    if (!insertBlocked) {
      throw new Error("FAIL: mz_app was able to insert into media_derivative!");
    }
    console.log("PASS: Privilege boundary verified (mz_app denied INSERT on media_derivative)");

  } finally {
    if (matchId) {
      await ownerClient.query("SET session_replication_role = 'replica'");
      await ownerClient.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
      await ownerClient.query("DELETE FROM media_asset WHERE match_id = $1", [matchId]);
      await ownerClient.query("DELETE FROM tg_match WHERE id = $1", [matchId]);
      await ownerClient.query("SET session_replication_role = 'origin'");
    }
    ownerClient.release();
    await pool.end();
    await ownerPool.end();
  }
  console.log("=== video-check.mjs PASSED ===");
}

run().catch((err) => {
  console.error("video-check failed:", err);
  process.exit(1);
});
