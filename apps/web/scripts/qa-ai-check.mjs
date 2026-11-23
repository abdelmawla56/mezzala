#!/usr/bin/env node
/**
 * qa-ai-check.mjs
 * Validates QA decisions (append-only), route handlers, and AI tagging contract.
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

import { GET as qaGET } from "../app/api/qa/route.ts";
import { GET as aiGET, POST as aiPOST } from "../app/api/ai-tagging/route.ts";
import { withTenant } from "../lib/db/with-tenant.ts";
import { hashToken } from "../lib/auth.ts";

async function run() {
  console.log("=== Running qa-ai-check.mjs ===");
  const ownerClient = await ownerPool.connect();
  let matchId;
  const token = "qa_ai_check_token_123";

  try {
    const matchRes = await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('GCLUB', 'QA_AI_CHECK_FIXTURE', CURRENT_DATE, 'HomeQA', 'AwayQA') RETURNING id"
    );
    matchId = matchRes.rows[0].id;

    const userRes = await ownerClient.query("SELECT id FROM users WHERE email = 'admin@gclub.dev'");
    const userId = userRes.rows[0]?.id || 1;
    await ownerClient.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour') ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at",
      [hashToken(token), userId]
    );

    let annId;
    let qdId;
    await withTenant(pool, "GCLUB", async (c) => {
      const annRes = await c.query("INSERT INTO annotation (club_id, match_id) VALUES ('GCLUB', $1) RETURNING id", [matchId]);
      annId = annRes.rows[0].id;

      // QA decision workflow: insert decision
      const qdRes = await c.query(
        "INSERT INTO qa_decision (club_id, annotation_id, decision) VALUES ('GCLUB', $1, 'accept') RETURNING id",
        [annId]
      );
      qdId = qdRes.rows[0].id;
    });
    console.log("PASS: QA decision recorded in tenant context");

    // Test GET /api/qa route
    const req = new Request(`http://localhost:3600/api/qa?match_id=${matchId}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const res = await qaGET(req);
    const json = await res.json();
    if (res.status !== 200 || json.rows.length !== 1 || json.rows[0].decision !== "accept") {
      throw new Error(`GET /api/qa failed: status=${res.status}, body=${JSON.stringify(json)}`);
    }
    console.log("PASS: GET /api/qa verified via authenticated session");

    // Test append-only: mz_app cannot update or delete qa_decision
    let updateDenied = false;
    try {
      await withTenant(pool, "GCLUB", async (c) => {
        await c.query("UPDATE qa_decision SET decision = 'reject' WHERE id = $1", [qdId]);
      });
    } catch (err) {
      if (err.message.includes("permission denied") || err.code === "42501" || err.message.includes("append-only")) {
        updateDenied = true;
      }
    }
    if (!updateDenied) {
      throw new Error("FAIL: mz_app was able to update qa_decision!");
    }
    console.log("PASS: qa_decision append-only update denied");

    // Test AI tagging endpoint contract (anonymous -> 401, authenticated -> 409)
    const aiReqAnon = new Request("http://localhost:3600/api/ai-tagging");
    const aiResAnon = await aiGET(aiReqAnon);
    if (aiResAnon.status !== 401) {
      throw new Error(`Expected 401 on anonymous AI tagging GET, got ${aiResAnon.status}`);
    }

    const aiReqGet = new Request("http://localhost:3600/api/ai-tagging", {
      headers: { authorization: `Bearer ${token}` }
    });
    const aiResGet = await aiGET(aiReqGet);
    const aiJsonGet = await aiResGet.json();
    if (aiResGet.status !== 409 || aiJsonGet.error !== "no_vendor" || !aiJsonGet.message_en || !aiJsonGet.message_ar) {
      throw new Error(`GET /api/ai-tagging contract violation: ${JSON.stringify(aiJsonGet)}`);
    }

    const aiReqPost = new Request("http://localhost:3600/api/ai-tagging", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    const aiResPost = await aiPOST(aiReqPost);
    const aiJsonPost = await aiResPost.json();
    if (aiResPost.status !== 409 || aiJsonPost.error !== "no_vendor") {
      throw new Error(`POST /api/ai-tagging contract violation: ${JSON.stringify(aiJsonPost)}`);
    }
    console.log("PASS: AI tagging contract verified (HTTP 409 bilingual no_vendor response)");

  } finally {
    if (matchId) {
      await ownerClient.query("SET session_replication_role = 'replica'");
      await ownerClient.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
      await ownerClient.query("DELETE FROM qa_decision WHERE club_id = 'GCLUB'");
      await ownerClient.query("DELETE FROM annotation WHERE match_id = $1", [matchId]);
      await ownerClient.query("DELETE FROM tg_match WHERE id = $1", [matchId]);
      await ownerClient.query("SET session_replication_role = 'origin'");
    }
    ownerClient.release();
    await pool.end();
    await ownerPool.end();
  }
  console.log("=== qa-ai-check.mjs PASSED ===");
}

run().catch((err) => {
  console.error("qa-ai-check failed:", err);
  process.exit(1);
});
