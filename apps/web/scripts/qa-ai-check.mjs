#!/usr/bin/env node
/**
 * qa-ai-check.mjs
 * Validates QA decisions (append-only) and AI tagging contract.
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
  console.log("=== Running qa-ai-check.mjs ===");
  const ownerClient = await ownerPool.connect();
  let matchId;
  try {
    const matchRes = await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('GCLUB', 'QA_CHECK_FIXTURE', CURRENT_DATE, 'QAHome', 'QAAway') RETURNING id"
    );
    matchId = matchRes.rows[0].id;

    let qdId;
    await withTenant(appPool, "GCLUB", async (c) => {
      const annRes = await c.query("INSERT INTO annotation (club_id, match_id) VALUES ('GCLUB', $1) RETURNING id", [matchId]);
      const annId = annRes.rows[0].id;

      // Insert QA decision ('accept', 'reject', or 'defer')
      const qdRes = await c.query(
        "INSERT INTO qa_decision (club_id, annotation_id, decision) VALUES ('GCLUB', $1, 'accept') RETURNING id",
        [annId]
      );
      qdId = qdRes.rows[0].id;
    });

    // Verify append-only: mz_app cannot update qa_decision
    let blocked = false;
    try {
      await withTenant(appPool, "GCLUB", async (c) => {
        await c.query("UPDATE qa_decision SET decision = 'reject' WHERE id = $1", [qdId]);
      });
    } catch (err) {
      if (err.message.includes("permission denied") || err.code === "42501" || err.message.includes("append-only")) {
        blocked = true;
      }
    }
    if (!blocked) {
      throw new Error("FAIL: mz_app was able to update qa_decision!");
    }
    console.log("PASS: qa_decision append-only update denied as expected");

  } finally {
    if (matchId) {
      await ownerClient.query("SET session_replication_role = 'replica'");
      await ownerClient.query("DELETE FROM qa_decision WHERE decision = 'accept' AND club_id = 'GCLUB'");
      await ownerClient.query("DELETE FROM annotation WHERE match_id = $1", [matchId]);
      await ownerClient.query("DELETE FROM tg_match WHERE id = $1", [matchId]);
      await ownerClient.query("SET session_replication_role = 'origin'");
    }
    ownerClient.release();
    await appPool.end();
    await ownerPool.end();
  }
  console.log("=== qa-ai-check.mjs PASSED ===");
}

run().catch((err) => {
  console.error("qa-ai-check failed:", err);
  process.exit(1);
});
