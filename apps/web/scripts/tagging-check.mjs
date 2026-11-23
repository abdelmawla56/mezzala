#!/usr/bin/env node
/**
 * tagging-check.mjs
 * Thorough validation of tagging workflows, immutable revisions, and store functions.
 * Uses mz_app for runtime operations via withTenant(), owner for setup/cleanup.
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

import { annotationsOf } from "../lib/tagging/store.ts";
import { GET as taggingGET } from "../app/api/tagging/route.ts";
import { withTenant } from "../lib/db/with-tenant.ts";
import { hashToken } from "../lib/auth.ts";

async function run() {
  console.log("=== Running tagging-check.mjs ===");
  const ownerClient = await ownerPool.connect();
  let matchId;
  const token = "tagging_check_token_xyz";

  try {
    // 1. Setup match & user session via owner
    const matchRes = await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('GCLUB', 'TAGGING_WORKFLOW_TEST', CURRENT_DATE, 'TeamA', 'TeamB') RETURNING id"
    );
    matchId = matchRes.rows[0].id;

    const userRes = await ownerClient.query("SELECT id FROM users WHERE email = 'admin@gclub.dev'");
    const userId = userRes.rows[0]?.id || 1;
    await ownerClient.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour') ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at",
      [hashToken(token), userId]
    );

    // 2. Perform Tagging operations as mz_app
    let annId;
    await withTenant(pool, "GCLUB", async (c) => {
      // Create annotation
      const aRes = await c.query(
        "INSERT INTO annotation (club_id, match_id, kind) VALUES ('GCLUB', $1, 'manual') RETURNING id",
        [matchId]
      );
      annId = aRes.rows[0].id;

      // Add revision 1
      await c.query(
        "INSERT INTO annotation_revision (club_id, annotation_id, rev, match_ms, payload) VALUES ('GCLUB', $1, 1, 12000, '{\"tag\":\"shot\",\"outcome\":\"goal\"}')",
        [annId]
      );

      // Add revision 2 (correction / refinement)
      await c.query(
        "INSERT INTO annotation_revision (club_id, annotation_id, rev, match_ms, payload) VALUES ('GCLUB', $1, 2, 12500, '{\"tag\":\"shot\",\"outcome\":\"goal\",\"scorer\":\"9\"}')",
        [annId]
      );
    });
    console.log("PASS: Multi-revision annotations inserted under withTenant");

    // 3. Test store.ts: annotationsOf must return latest revision (rev 2)
    const stored = await annotationsOf("GCLUB", matchId);
    if (stored.length !== 1 || stored[0].rev !== 2 || Number(stored[0].match_ms) !== 12500) {
      throw new Error(`annotationsOf did not return the latest revision: ${JSON.stringify(stored)}`);
    }
    console.log("PASS: store.annotationsOf() returned latest revision (rev 2, 12500ms)");

    // 4. Test route handler: GET /api/tagging?match_id=... with Bearer token
    const req = new Request(`http://localhost:3600/api/tagging?match_id=${matchId}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const res = await taggingGET(req);
    const json = await res.json();
    if (res.status !== 200 || json.rows.length !== 1 || json.rows[0].rev !== 2) {
      throw new Error(`Route GET /api/tagging failed: status=${res.status}, json=${JSON.stringify(json)}`);
    }
    console.log("PASS: GET /api/tagging route returned HTTP 200 with latest revision");

    // 5. Test immutable revisions: mz_app cannot update revision 1
    let updateDenied = false;
    try {
      await withTenant(pool, "GCLUB", async (c) => {
        await c.query("UPDATE annotation_revision SET match_ms = 9999 WHERE annotation_id = $1 AND rev = 1", [annId]);
      });
    } catch (err) {
      if (err.message.includes("permission denied") || err.code === "42501" || err.message.includes("append-only")) {
        updateDenied = true;
      }
    }
    if (!updateDenied) {
      throw new Error("FAIL: mz_app was able to update annotation_revision!");
    }
    console.log("PASS: Revision immutability verified (UPDATE denied on mz_app)");

  } finally {
    if (matchId) {
      await ownerClient.query("SET session_replication_role = 'replica'");
      await ownerClient.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
      await ownerClient.query("DELETE FROM annotation_revision WHERE annotation_id IN (SELECT id FROM annotation WHERE match_id = $1)", [matchId]);
      await ownerClient.query("DELETE FROM annotation WHERE match_id = $1", [matchId]);
      await ownerClient.query("DELETE FROM tg_match WHERE id = $1", [matchId]);
      await ownerClient.query("SET session_replication_role = 'origin'");
    }
    ownerClient.release();
    await pool.end();
    await ownerPool.end();
  }
  console.log("=== tagging-check.mjs PASSED ===");
}

run().catch((err) => {
  console.error("tagging-check failed:", err);
  process.exit(1);
});
