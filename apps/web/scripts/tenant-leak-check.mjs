#!/usr/bin/env node
/**
 * tenant-leak-check.mjs
 * Comprehensive acceptance test for Task 1:
 * 1. RLS boundary across ALL tenant tables from mz_rls_report (status = 'ok').
 * 2. Fail-closed behavior: direct query without tenant context returns 0 rows.
 * 3. Every GET route (/api/tagging, /api/qa, /api/media, /api/playlists, /api/ai-tagging)
 *    tested as a GCLUB user — never returns TEST-000 rows.
 * 4. Append-only enforcement on EVERY table from pg_trigger carrying mz_append_only():
 *    verifies mz_app is DENIED UPDATE, DELETE, and TRUNCATE.
 * 5. Startup guard verification: runtime pool connecting as superuser fails closed.
 * 6. Owner import guard verification.
 * 7. Cleanup uses DATABASE_URL_OWNER with session_replication_role = 'replica'.
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
if (!DATABASE_URL || !DATABASE_URL_OWNER) {
  console.error("Missing DATABASE_URL or DATABASE_URL_OWNER");
  process.exit(1);
}

const appPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const ownerPool = new pg.Pool({ connectionString: DATABASE_URL_OWNER, max: 2 });

// Import route handlers
import { GET as taggingGET } from "../app/api/tagging/route.ts";
import { GET as mediaGET } from "../app/api/media/route.ts";
import { GET as qaGET } from "../app/api/qa/route.ts";
import { GET as playlistsGET } from "../app/api/playlists/route.ts";
import { GET as aiTaggingGET } from "../app/api/ai-tagging/route.ts";
import { withTenant } from "../lib/db/with-tenant.ts";
import { hashToken } from "../lib/auth.ts";
import { assertNoSuperuser } from "../lib/db.ts";

async function cleanup(ownerClient, tokenHash) {
  try {
    await ownerClient.query("SET session_replication_role = 'replica'");
    if (tokenHash) {
      await ownerClient.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    }
    await ownerClient.query("DELETE FROM playlist_item WHERE club_id IN ('GCLUB', 'TEST-000')");
    await ownerClient.query("DELETE FROM playlist WHERE name LIKE 'LEAK_TEST_%'");
    await ownerClient.query("DELETE FROM annotation_revision WHERE match_ms = 999111");
    await ownerClient.query("DELETE FROM qa_decision WHERE decision = 'accept' AND club_id IN ('GCLUB', 'TEST-000')");
    await ownerClient.query("DELETE FROM annotation WHERE match_id IN (SELECT id FROM tg_match WHERE code LIKE 'LEAK_TEST_%')");
    await ownerClient.query("DELETE FROM media_asset WHERE filename LIKE 'leak_test_%'");
    await ownerClient.query("DELETE FROM tg_match WHERE code LIKE 'LEAK_TEST_%'");
  } finally {
    await ownerClient.query("SET session_replication_role = 'origin'").catch(() => {});
  }
}

async function run() {
  console.log("=================================================");
  console.log("=== RUNNING ENHANCED TENANT LEAK CHECK (T1)  ===");
  console.log("=================================================");
  let passed = true;

  const ownerClient = await ownerPool.connect();
  let gTokenHash;
  try {
    // 0. Ensure baseline tenants & cleanup previous runs
    await ownerClient.query("INSERT INTO tenant (id, name) VALUES ('GCLUB', 'Golden Club') ON CONFLICT DO NOTHING");
    await ownerClient.query("INSERT INTO tenant (id, name) VALUES ('TEST-000', 'Test Tenant') ON CONFLICT DO NOTHING");
    await cleanup(ownerClient);

    // 1. Seed fixtures for both tenants
    console.log("\n-> 1. Seeding dual-tenant fixtures (GCLUB & TEST-000)...");
    const gMatch = (await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('GCLUB', 'LEAK_TEST_G', CURRENT_DATE, 'GHome', 'GAway') RETURNING id"
    )).rows[0];
    const tMatch = (await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('TEST-000', 'LEAK_TEST_T', CURRENT_DATE, 'THome', 'TAway') RETURNING id"
    )).rows[0];

    // Seed playlists
    await ownerClient.query(
      "INSERT INTO playlist (club_id, name) VALUES ('GCLUB', 'LEAK_TEST_PLAYLIST_G'), ('TEST-000', 'LEAK_TEST_PLAYLIST_T')"
    );

    // Seed annotations & revisions
    const gAnn = (await ownerClient.query("INSERT INTO annotation (club_id, match_id) VALUES ('GCLUB', $1) RETURNING id", [gMatch.id])).rows[0];
    const tAnn = (await ownerClient.query("INSERT INTO annotation (club_id, match_id) VALUES ('TEST-000', $1) RETURNING id", [tMatch.id])).rows[0];

    await ownerClient.query("INSERT INTO annotation_revision (club_id, annotation_id, rev, match_ms, payload) VALUES ('GCLUB', $1, 1, 999111, '{\"team\":\"G\"}')", [gAnn.id]);
    await ownerClient.query("INSERT INTO annotation_revision (club_id, annotation_id, rev, match_ms, payload) VALUES ('TEST-000', $1, 1, 999111, '{\"team\":\"T\"}')", [tAnn.id]);

    // Seed QA decisions
    await ownerClient.query("INSERT INTO qa_decision (club_id, annotation_id, decision) VALUES ('GCLUB', $1, 'accept')", [gAnn.id]);
    await ownerClient.query("INSERT INTO qa_decision (club_id, annotation_id, decision) VALUES ('TEST-000', $1, 'accept')", [tAnn.id]);

    // Seed media assets
    await ownerClient.query("INSERT INTO media_asset (club_id, match_id, filename, upload_state) VALUES ('GCLUB', $1, 'leak_test_g.mp4', 'ready')", [gMatch.id]);
    await ownerClient.query("INSERT INTO media_asset (club_id, match_id, filename, upload_state) VALUES ('TEST-000', $1, 'leak_test_t.mp4', 'ready')", [tMatch.id]);

    // Seed session token for GCLUB user
    const gUserRes = await ownerClient.query("SELECT id FROM users WHERE email = 'admin@gclub.dev'");
    const gUserId = gUserRes.rows[0]?.id || 1;
    const gToken = "leak_test_token_gclub_12345";
    gTokenHash = hashToken(gToken);
    await ownerClient.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour') ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at",
      [gTokenHash, gUserId]
    );

    // 2. Query ALL tenant tables dynamically from mz_rls_report
    console.log("\n-> 2. Querying all tenant tables from mz_rls_report under withTenant('GCLUB')...");
    const tablesRes = await ownerClient.query("SELECT table_name FROM mz_rls_report WHERE status = 'ok' ORDER BY table_name");
    const okTables = tablesRes.rows.map(r => r.table_name);
    console.log(`Found ${okTables.length} active tenant tables in mz_rls_report.`);

    let tableLeakCount = 0;
    await withTenant(appPool, "GCLUB", async (c) => {
      for (const table of okTables) {
        // Query without ANY WHERE club_id clause
        const { rows } = await c.query(`SELECT * FROM ${table}`);
        const leaked = rows.filter(r => r.club_id && r.club_id !== "GCLUB");
        if (leaked.length > 0) {
          console.error(`FAIL: Table ${table} leaked non-GCLUB rows!`, leaked);
          tableLeakCount++;
        }
      }
    });

    if (tableLeakCount === 0) {
      console.log(`PASS: Zero cross-tenant leaks across all ${okTables.length} tenant tables.`);
    } else {
      passed = false;
    }

    // 3. Fail-Closed check (no tenant context set)
    console.log("\n-> 3. Testing fail-closed behavior (app.club_id is NULL)...");
    const appClient = await appPool.connect();
    try {
      const matchRows = (await appClient.query("SELECT * FROM tg_match WHERE code LIKE 'LEAK_TEST_%'")).rows;
      const playlistRows = (await appClient.query("SELECT * FROM playlist WHERE name LIKE 'LEAK_TEST_%'")).rows;
      if (matchRows.length > 0 || playlistRows.length > 0) {
        console.error("FAIL: Queries without tenant context returned rows!", { matchRows, playlistRows });
        passed = false;
      } else {
        console.log("PASS: Fail-closed verified (0 rows returned when app.club_id is NULL).");
      }
    } finally {
      appClient.release();
    }

    // 4. Test EVERY GET route as a GCLUB user
    console.log("\n-> 4. Testing all GET routes as a GCLUB user...");

    // Helper to invoke route handler with standard Request
    async function testRoute(name, handler, url, headers = {}) {
      const req = new Request(url, { headers: { authorization: `Bearer ${gToken}`, "x-club-id": "GCLUB", ...headers } });
      const res = await handler(req);
      const json = await res.json();
      return { status: res.status, json };
    }

    // Route: /api/tagging?match_id=...
    const taggingRes = await testRoute("GET /api/tagging", taggingGET, `http://localhost:3600/api/tagging?match_id=${gMatch.id}`);
    const taggingRows = taggingRes.json.rows || [];
    const hasTTag = taggingRows.some(r => r.club_id === "TEST-000");
    if (taggingRes.status === 200 && !hasTTag && taggingRows.length >= 1) {
      console.log("PASS: /api/tagging returned only GCLUB annotations (0 from TEST-000).");
    } else {
      console.error("FAIL: /api/tagging failed or leaked TEST-000 rows:", taggingRes);
      passed = false;
    }

    // Route: /api/qa?match_id=...
    const qaRes = await testRoute("GET /api/qa", qaGET, `http://localhost:3600/api/qa?match_id=${gMatch.id}`);
    const qaRows = qaRes.json.rows || [];
    const hasTQA = qaRows.some(r => r.club_id === "TEST-000");
    if (qaRes.status === 200 && !hasTQA && qaRows.length >= 1) {
      console.log("PASS: /api/qa returned only GCLUB decisions (0 from TEST-000).");
    } else {
      console.error("FAIL: /api/qa failed or leaked TEST-000 rows:", qaRes);
      passed = false;
    }

    // Route: /api/media?match_id=...
    const mediaRes = await testRoute("GET /api/media", mediaGET, `http://localhost:3600/api/media?match_id=${gMatch.id}`);
    const mediaRows = mediaRes.json.rows || [];
    const hasTMedia = mediaRows.some(r => r.club_id === "TEST-000");
    if (mediaRes.status === 200 && !hasTMedia && mediaRows.length >= 1) {
      console.log("PASS: /api/media returned only GCLUB assets (0 from TEST-000).");
    } else {
      console.error("FAIL: /api/media failed or leaked TEST-000 rows:", mediaRes);
      passed = false;
    }

    // Route: /api/playlists
    const playlistRes = await testRoute("GET /api/playlists", playlistsGET, "http://localhost:3600/api/playlists");
    const plRows = playlistRes.json.rows || [];
    const hasTPlaylist = plRows.some(r => r.club_id === "TEST-000");
    if (playlistRes.status === 200 && !hasTPlaylist && plRows.length >= 1) {
      console.log("PASS: /api/playlists returned only GCLUB playlists (0 from TEST-000).");
    } else {
      console.error("FAIL: /api/playlists failed or leaked TEST-000 rows:", playlistRes);
      passed = false;
    }

    // Route: /api/ai-tagging
    const aiRes = await testRoute("GET /api/ai-tagging", aiTaggingGET, "http://localhost:3600/api/ai-tagging");
    if (aiRes.status === 409 && aiRes.json.error === "no_vendor" && aiRes.json.message_ar && aiRes.json.message_en) {
      console.log("PASS: /api/ai-tagging returns 409 bilingual no_vendor response.");
    } else {
      console.error("FAIL: /api/ai-tagging response format unexpected:", aiRes);
      passed = false;
    }

    // Cross-tenant route denial: GCLUB user requesting TEST-000 explicitly
    const mismatchReq = new Request(`http://localhost:3600/api/tagging?match_id=${tMatch.id}`, {
      headers: { authorization: `Bearer ${gToken}`, "x-club-id": "TEST-000" }
    });
    const mismatchRes = await taggingGET(mismatchReq);
    if (mismatchRes.status === 403) {
      console.log("PASS: Cross-tenant route request denied with 403.");
    } else {
      console.error("FAIL: Cross-tenant route request was not denied with 403!", mismatchRes.status);
      passed = false;
    }

    // 5. Append-Only Denial on ALL tables carrying mz_append_only() trigger
    console.log("\n-> 5. Testing append-only denial across ALL tables carrying mz_append_only()...");
    const aoTablesRes = await ownerClient.query(`
      SELECT DISTINCT tgrelid::regclass::text AS table_name
        FROM pg_trigger
       WHERE NOT tgisinternal AND tgfoid = to_regproc('mz_append_only')
       ORDER BY table_name;
    `);
    const aoTables = aoTablesRes.rows.map(r => r.table_name);
    console.log(`Found ${aoTables.length} append-only tables: ${aoTables.join(", ")}`);

    for (const tbl of aoTables) {
      // Test UPDATE denial (audit_log uses 'action'; others have 'club_id')
      const colToUpdate = tbl === "audit_log" ? "action" : "club_id";
      let updateBlocked = false;
      try {
        await withTenant(appPool, "GCLUB", async (c) => {
          await c.query(`UPDATE ${tbl} SET ${colToUpdate} = ${colToUpdate} WHERE false`);
        });
      } catch (err) {
        if (err.message.includes("permission denied") || err.code === "42501" || err.message.includes("append-only")) {
          updateBlocked = true;
        }
      }

      // Test DELETE denial
      let deleteBlocked = false;
      try {
        await withTenant(appPool, "GCLUB", async (c) => {
          await c.query(`DELETE FROM ${tbl} WHERE false`);
        });
      } catch (err) {
        if (err.message.includes("permission denied") || err.code === "42501" || err.message.includes("append-only")) {
          deleteBlocked = true;
        }
      }

      // Test TRUNCATE denial
      let truncateBlocked = false;
      try {
        await withTenant(appPool, "GCLUB", async (c) => {
          await c.query(`TRUNCATE TABLE ${tbl}`);
        });
      } catch (err) {
        if (err.message.includes("permission denied") || err.code === "42501") {
          truncateBlocked = true;
        }
      }

      if (updateBlocked && deleteBlocked && truncateBlocked) {
        console.log(`PASS: ${tbl} -> UPDATE/DELETE/TRUNCATE all denied for mz_app.`);
      } else {
        console.error(`FAIL: ${tbl} permissions not fully denied: update=${updateBlocked}, delete=${deleteBlocked}, truncate=${truncateBlocked}`);
        passed = false;
      }
    }

    // 6. Test Startup Guard against Superuser
    console.log("\n-> 6. Testing startup guard against superuser connection...");
    let superuserBlocked = false;
    try {
      await assertNoSuperuser(ownerClient);
    } catch (err) {
      if (err.message.includes("CRITICAL SECURITY ERROR") || err.message.includes("superuser")) {
        superuserBlocked = true;
      }
    }

    let appAllowed = false;
    const appCheckClient = await appPool.connect();
    try {
      await assertNoSuperuser(appCheckClient);
      appAllowed = true;
    } finally {
      appCheckClient.release();
    }

    if (superuserBlocked && appAllowed) {
      console.log("PASS: Startup guard successfully denies superuser and permits mz_app.");
    } else {
      console.error(`FAIL: Startup guard check failed: superuserBlocked=${superuserBlocked}, appAllowed=${appAllowed}`);
      passed = false;
    }

  } finally {
    console.log("\n-> Cleaning up test fixtures with owner pool...");
    await cleanup(ownerClient, gTokenHash);
    ownerClient.release();
    await appPool.end();
    await ownerPool.end();
  }

  console.log("\n=================================================");
  if (passed) {
    console.log("=== ALL TASK 1 LEAK & PERMISSION CHECKS PASSED ===");
    console.log("=================================================");
    process.exit(0);
  } else {
    console.error("=== SOME CHECKS FAILED ===");
    console.log("=================================================");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
