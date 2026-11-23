#!/usr/bin/env node
/**
 * tenant-leak-check.mjs
 * Rigorous end-to-end acceptance test for Task 1:
 * 
 * 1. REAL HTTP route tests against live dev server (http://localhost:3600):
 *    - No session cookie -> 401 Unauthorized across all routes
 *    - Invalid session cookie -> 401 Unauthorized
 *    - Expired session cookie -> 401 Unauthorized
 *    - GCLUB session cookie + x-club-id: TEST-000 -> 403 Forbidden
 *    - GCLUB session cookie requesting TEST-000 match_id -> 404 or empty {"rows": []}
 *    - GCLUB session cookie requesting GCLUB match_id -> 200 with only GCLUB data
 *    - AI tagging endpoint -> 409 bilingual no_vendor response
 * 
 * 2. DATABASE-LEVEL tenant isolation & privilege tests:
 *    - RLS boundary across ALL 41 tenant tables from mz_rls_report under withTenant('GCLUB')
 *    - Fail-closed behavior: direct query without tenant context returns 0 rows
 *    - Append-only enforcement on ALL 7 tables carrying mz_append_only() trigger:
 *      UPDATE, DELETE, and TRUNCATE all denied for mz_app
 *    - Startup guard: proves connecting as superuser fails closed
 *    - Cleanup uses DATABASE_URL_OWNER with session_replication_role = 'replica'
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

import { withTenant } from "../lib/db/with-tenant.ts";
import { hashToken } from "../lib/auth.ts";
import { assertRuntimeRole, resetRoleGuardForTesting } from "../lib/db.ts";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3600";

async function cleanup(ownerClient, tokenHashes = []) {
  try {
    await ownerClient.query("SET session_replication_role = 'replica'");
    if (tokenHashes.length > 0) {
      await ownerClient.query("DELETE FROM sessions WHERE token_hash = ANY($1)", [tokenHashes]);
    }
    const { rows: okTables } = await ownerClient.query("SELECT table_name FROM mz_rls_report WHERE status = 'ok'");
    for (const { table_name } of okTables) {
      await ownerClient.query(`DELETE FROM ${table_name} WHERE club_id IN ('GCLUB', 'TEST-000')`);
    }
  } finally {
    await ownerClient.query("SET session_replication_role = 'origin'").catch(() => {});
  }
}

async function run() {
  console.log("=================================================");
  console.log("=== REAL HTTP & DB TENANT LEAK CHECK (TASK 1) ===");
  console.log("=================================================");
  let passed = true;

  const ownerClient = await ownerPool.connect();
  const createdTokens = [];
  try {
    // 0. Ensure baseline tenants & initial cleanup
    await ownerClient.query("INSERT INTO tenant (id, name) VALUES ('GCLUB', 'Golden Club') ON CONFLICT DO NOTHING");
    await ownerClient.query("INSERT INTO tenant (id, name) VALUES ('TEST-000', 'Test Tenant') ON CONFLICT DO NOTHING");
    await cleanup(ownerClient);

    // 1. Seed dual-tenant fixtures via owner
    console.log("\n-> 1. Seeding dual-tenant fixtures (GCLUB & TEST-000)...");
    const gMatch = (await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('GCLUB', 'LEAK_TEST_G', CURRENT_DATE, 'GHome', 'GAway') RETURNING id"
    )).rows[0];
    const gMatchEmpty = (await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('GCLUB', 'LEAK_TEST_EMPTY', CURRENT_DATE, 'GHomeEmpty', 'GAwayEmpty') RETURNING id"
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

    // Seed active session for GCLUB user
    const gUserRes = await ownerClient.query("SELECT id FROM users WHERE email = 'admin@gclub.dev'");
    const gUserId = gUserRes.rows[0]?.id || 1;
    const gToken = "valid_gclub_session_token_123456789";
    const gTokenHash = hashToken(gToken);
    createdTokens.push(gTokenHash);
    await ownerClient.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour') ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at",
      [gTokenHash, gUserId]
    );

    // Seed expired session for GCLUB user
    const expiredToken = "expired_gclub_session_token_987654321";
    const expiredTokenHash = hashToken(expiredToken);
    createdTokens.push(expiredTokenHash);
    await ownerClient.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() - interval '1 hour') ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at",
      [expiredTokenHash, gUserId]
    );

    // Seed dual-tenant fixtures for ALL other writable tenant tables (both GCLUB and TEST-000)
    for (const club of ["GCLUB", "TEST-000"]) {
      const isG = club === "GCLUB";
      const match = isG ? gMatch : tMatch;
      const ann = isG ? gAnn : tAnn;
      const uRes = await ownerClient.query("SELECT id FROM users WHERE club_id = $1 LIMIT 1", [club]);
      const uid = uRes.rows[0]?.id || gUserId;

      // tg_team
      await ownerClient.query("INSERT INTO tg_team (club_id, name, code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [club, `Team ${club}`, `TM_${club}`]);
      // tenant_flag
      await ownerClient.query("INSERT INTO tenant_flag (club_id, flag, value) VALUES ($1, 'leak_flag', 'val') ON CONFLICT DO NOTHING", [club]);
      // tag_template & tag_template_version
      const ttRes = await ownerClient.query("INSERT INTO tag_template (club_id, name) VALUES ($1, $2) RETURNING id", [club, `Template ${club}`]);
      await ownerClient.query("INSERT INTO tag_template_version (tag_template_id, club_id, version, schema_json) VALUES ($1, $2, 1, '{}') ON CONFLICT DO NOTHING", [ttRes.rows[0].id, club]);
      // qa_sample_policy & qa_tolerance
      await ownerClient.query("INSERT INTO qa_sample_policy (club_id, rate, kind) VALUES ($1, 1, 'all')", [club]);
      await ownerClient.query("INSERT INTO qa_tolerance (club_id, metric, value) VALUES ($1, 'metric', 1.0)", [club]);
      // ai_model & ai_model_gate & ai_model_threshold
      const amRes = await ownerClient.query("INSERT INTO ai_model (club_id, name, kind) VALUES ($1, $2, 'tagging') RETURNING id", [club, `Model ${club}`]);
      await ownerClient.query("INSERT INTO ai_model_gate (ai_model_id, club_id, enabled) VALUES ($1, $2, true)", [amRes.rows[0].id, club]);
      await ownerClient.query("INSERT INTO ai_model_threshold (ai_model_id, club_id, metric, threshold) VALUES ($1, $2, 'conf', 0.8)", [amRes.rows[0].id, club]);
      // rights_record
      await ownerClient.query("INSERT INTO rights_record (club_id, match_id, notes) VALUES ($1, $2, 'leak note')", [club, match.id]);
      // analysis_run
      await ownerClient.query("INSERT INTO analysis_run (club_id, match_id, kind) VALUES ($1, $2, 'leak_analysis')", [club, match.id]);
      // media_job
      await ownerClient.query("INSERT INTO media_job (club_id, kind, asset_ref, payload, idempotency_key) VALUES ($1, 'probe', 'leak_asset', '{\"key\":\"leak\"}', $2) ON CONFLICT DO NOTHING", [club, `idem_leak_${club}`]);
      // tagging_pass & tg_coverage
      const tpRes = await ownerClient.query("INSERT INTO tagging_pass (match_id, club_id, status) VALUES ($1, $2, 'open') RETURNING id", [match.id, club]);
      await ownerClient.query("INSERT INTO tg_coverage (pass_id, club_id) VALUES ($1, $2)", [tpRes.rows[0].id, club]);
      // qa_pending_signature
      await ownerClient.query("INSERT INTO qa_pending_signature (club_id, annotation_id) VALUES ($1, $2)", [club, ann.id]);
      // tg_match_status
      await ownerClient.query("INSERT INTO tg_match_status (match_id, club_id, status) VALUES ($1, $2, 'draft')", [match.id, club]);
      // tg_lineup
      await ownerClient.query("INSERT INTO tg_lineup (match_id, club_id, team, player) VALUES ($1, $2, 'Team', 'Player')", [match.id, club]);
      // tg_minors
      await ownerClient.query("INSERT INTO tg_minors (match_id, club_id, player) VALUES ($1, $2, 'Minor')", [match.id, club]);
      // tg_timeline
      await ownerClient.query("INSERT INTO tg_timeline (match_id, club_id, event_code, match_ms) VALUES ($1, $2, 'EVT', 1000)", [match.id, club]);
      // tg_direction
      await ownerClient.query("INSERT INTO tg_direction (match_id, club_id, period, attack_dir) VALUES ($1, $2, 1, 'L2R')", [match.id, club]);
      // sync_set, sync_anchor, media_gap, media_exclusion
      const ssRes = await ownerClient.query("INSERT INTO sync_set (match_id, club_id, label) VALUES ($1, $2, 'Sync') RETURNING id", [match.id, club]);
      await ownerClient.query("INSERT INTO sync_anchor (sync_set_id, club_id, video_ms) VALUES ($1, $2, 100)", [ssRes.rows[0].id, club]);
      await ownerClient.query("INSERT INTO media_gap (sync_set_id, club_id, start_ms, end_ms) VALUES ($1, $2, 10, 20)", [ssRes.rows[0].id, club]);
      await ownerClient.query("INSERT INTO media_exclusion (sync_set_id, club_id, reason) VALUES ($1, $2, 'excl')", [ssRes.rows[0].id, club]);
      // adjudication, agreement_run, counting_assignment, match_signoff, model_run, tg_assignment, event_snapshot
      await ownerClient.query("INSERT INTO adjudication (match_id, club_id, status) VALUES ($1, $2, 'pending')", [match.id, club]);
      await ownerClient.query("INSERT INTO agreement_run (match_id, club_id, score) VALUES ($1, $2, 0.9)", [match.id, club]);
      await ownerClient.query("INSERT INTO counting_assignment (match_id, club_id, user_id) VALUES ($1, $2, $3)", [match.id, club, uid]);
      await ownerClient.query("INSERT INTO match_signoff (match_id, club_id, action) VALUES ($1, $2, 'signed')", [match.id, club]);
      await ownerClient.query("INSERT INTO model_run (match_id, club_id, ai_model_id) VALUES ($1, $2, $3)", [match.id, club, amRes.rows[0].id]);
      await ownerClient.query("INSERT INTO tg_assignment (club_id, match_id, user_id, role) VALUES ($1, $2, $3, 'tagger')", [club, match.id, uid]);
      await ownerClient.query("INSERT INTO event_snapshot (club_id, match_id, payload) VALUES ($1, $2, '{}')", [club, match.id]);
      // playlist items, shares, comments
      const plRes = await ownerClient.query("SELECT id FROM playlist WHERE club_id = $1 LIMIT 1", [club]);
      const plId = plRes.rows[0].id;
      await ownerClient.query("INSERT INTO playlist_item (playlist_id, club_id, annotation_id) VALUES ($1, $2, $3)", [plId, club, ann.id]);
      await ownerClient.query("INSERT INTO playlist_share (playlist_id, club_id, shared_with) VALUES ($1, $2, $3)", [plId, club, uid]);
      await ownerClient.query("INSERT INTO playlist_comment (playlist_id, club_id, user_id, body) VALUES ($1, $2, $3, 'comment')", [plId, club, uid]);
    }

    // 2. REAL HTTP ROUTE TESTS AGAINST LIVE DEV SERVER
    console.log(`\n-> 2. Executing Real HTTP tests against ${BASE_URL}...`);

    // Helper for real HTTP fetch
    async function httpReq(path, { cookie, headers = {}, method = "GET", body } = {}) {
      const reqHeaders = { ...headers };
      if (cookie) reqHeaders["Cookie"] = cookie;
      if (body) reqHeaders["Content-Type"] = "application/json";

      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: reqHeaders,
        body: body ? JSON.stringify(body) : undefined,
      });

      let json = null;
      try {
        json = await res.json();
      } catch {}
      return { status: res.status, json };
    }

    // Test Case A: No cookie gives 401 across every tenant route
    console.log("   [Case A] Verifying anonymous requests return 401 on every tenant route...");
    const routesToTest = [
      { method: "GET",  path: "/api/playlists" },
      { method: "GET",  path: `/api/tagging?match_id=${gMatch.id}` },
      { method: "GET",  path: `/api/media?match_id=${gMatch.id}` },
      { method: "GET",  path: `/api/qa?match_id=${gMatch.id}` },
      { method: "GET",  path: "/api/ai-tagging" },
      { method: "POST", path: "/api/ai-tagging" },
    ];
    for (const { method, path: r } of routesToTest) {
      const res = await httpReq(r, { method });
      if (res.status === 401) {
        console.log(`   PASS: Anonymous ${method} ${r} -> 401 Unauthorized`);
      } else {
        console.error(`   FAIL: Anonymous ${method} ${r} did NOT return 401! Got ${res.status}`);
        passed = false;
      }
    }

    // Test Case B: Invalid cookie gives 401
    console.log("   [Case B] Verifying invalid session cookie returns 401...");
    const invalidRes = await httpReq("/api/playlists", { cookie: "mz_session=invalid_nonexistent_token" });
    if (invalidRes.status === 401) {
      console.log("   PASS: Invalid cookie -> 401 Unauthorized");
    } else {
      console.error(`   FAIL: Invalid cookie did NOT return 401! Got ${invalidRes.status}`);
      passed = false;
    }

    // Test Case C: Expired session cookie gives 401
    console.log("   [Case C] Verifying expired session cookie returns 401...");
    const expiredRes = await httpReq("/api/playlists", { cookie: `mz_session=${expiredToken}` });
    if (expiredRes.status === 401) {
      console.log("   PASS: Expired session cookie -> 401 Unauthorized");
    } else {
      console.error(`   FAIL: Expired session cookie did NOT return 401! Got ${expiredRes.status}`);
      passed = false;
    }

    // Test Case D: GCLUB cookie asking for GCLUB match -> 200 with GCLUB data (0 from TEST-000)
    console.log("   [Case D] Verifying authenticated GCLUB user receives GCLUB data...");
    const gclubCookie = `mz_session=${gToken}`;

    const plRes = await httpReq("/api/playlists", { cookie: gclubCookie });
    const plRows = plRes.json?.rows || [];
    const hasTestPl = plRows.some(r => r.club_id === "TEST-000");
    if (plRes.status === 200 && !hasTestPl && plRows.length >= 1) {
      console.log(`   PASS: GET /api/playlists -> 200 OK (${plRows.length} GCLUB playlists, 0 from TEST-000)`);
    } else {
      console.error("   FAIL: GET /api/playlists failed or leaked TEST-000 data:", plRes);
      passed = false;
    }

    const tagRes = await httpReq(`/api/tagging?match_id=${gMatch.id}`, { cookie: gclubCookie });
    const tagRows = tagRes.json?.rows || [];
    const hasTestTag = tagRows.some(r => r.club_id === "TEST-000");
    if (tagRes.status === 200 && !hasTestTag && tagRows.length >= 1) {
      console.log(`   PASS: GET /api/tagging?match_id=${gMatch.id} -> 200 OK (${tagRows.length} GCLUB tags, 0 from TEST-000)`);
    } else {
      console.error("   FAIL: GET /api/tagging failed or leaked TEST-000 data:", tagRes);
      passed = false;
    }

    // Test Case E: GCLUB cookie + x-club-id: TEST-000 -> 403 Forbidden
    console.log("   [Case E] Verifying forged x-club-id: TEST-000 is rejected with 403 Forbidden...");
    const forgedRes = await httpReq("/api/playlists", {
      cookie: gclubCookie,
      headers: { "x-club-id": "TEST-000" },
    });
    if (forgedRes.status === 403) {
      console.log("   PASS: GCLUB cookie with forged x-club-id: TEST-000 -> 403 Forbidden");
    } else {
      console.error(`   FAIL: Forged x-club-id did NOT return 403! Got ${forgedRes.status}`);
      passed = false;
    }

    // Test Case E2: GCLUB user requesting empty-but-valid match -> 200 with empty rows []
    console.log("   [Case E2] Verifying empty-but-valid match returns 200 with empty list...");
    const emptyTagRes = await httpReq(`/api/tagging?match_id=${gMatchEmpty.id}`, { cookie: gclubCookie });
    const emptyMediaRes = await httpReq(`/api/media?match_id=${gMatchEmpty.id}`, { cookie: gclubCookie });
    const emptyQaRes = await httpReq(`/api/qa?match_id=${gMatchEmpty.id}`, { cookie: gclubCookie });

    if (emptyTagRes.status === 200 && Array.isArray(emptyTagRes.json?.rows) && emptyTagRes.json.rows.length === 0 &&
        emptyMediaRes.status === 200 && Array.isArray(emptyMediaRes.json?.rows) && emptyMediaRes.json.rows.length === 0 &&
        emptyQaRes.status === 200 && Array.isArray(emptyQaRes.json?.rows) && emptyQaRes.json.rows.length === 0) {
      console.log(`   PASS: Empty-but-valid match returned 200 with [] on /api/tagging, /api/media, /api/qa`);
    } else {
      console.error("   FAIL: Empty-but-valid match did not return 200 with empty list:", {
        tagging: emptyTagRes,
        media: emptyMediaRes,
        qa: emptyQaRes,
      });
      passed = false;
    }

    // Test Case F: GCLUB cookie asking for TEST-000 match_id or missing match -> 404 match_not_found
    console.log("   [Case F] Verifying GCLUB user asking for cross-tenant or missing match_id returns 404...");
    const crossMatchRes = await httpReq(`/api/tagging?match_id=${tMatch.id}`, { cookie: gclubCookie });
    const crossMediaRes = await httpReq(`/api/media?match_id=${tMatch.id}`, { cookie: gclubCookie });
    const crossQaRes = await httpReq(`/api/qa?match_id=${tMatch.id}`, { cookie: gclubCookie });
    const missingMatchRes = await httpReq(`/api/tagging?match_id=999999`, { cookie: gclubCookie });

    if (crossMatchRes.status === 404 && crossMediaRes.status === 404 && crossQaRes.status === 404 && missingMatchRes.status === 404) {
      console.log("   PASS: Cross-tenant & non-existent match requests returned 404 (0 rows leaked)");
    } else {
      console.error("   FAIL: Cross-tenant/missing match request did not return 404:", {
        crossTag: crossMatchRes.status,
        crossMedia: crossMediaRes.status,
        crossQa: crossQaRes.status,
        missing: missingMatchRes.status,
      });
      passed = false;
    }

    // Test Case G: AI tagging endpoint -> 409 bilingual no_vendor (authenticated)
    console.log("   [Case G] Verifying AI tagging contract (409 bilingual no_vendor) for authenticated user...");
    const aiRes = await httpReq("/api/ai-tagging", { method: "POST", cookie: gclubCookie });
    if (aiRes.status === 409 && aiRes.json?.error === "no_vendor" && aiRes.json?.message_ar && aiRes.json?.message_en) {
      console.log("   PASS: POST /api/ai-tagging (authenticated) -> 409 bilingual no_vendor");
    } else {
      console.error("   FAIL: AI tagging contract violation:", aiRes);
      passed = false;
    }

    // 3. DATABASE-LEVEL RLS CHECK ACROSS ALL 41 TENANT TABLES
    console.log("\n-> 3. Database RLS boundary check across ALL tables in mz_rls_report...");
    const tablesRes = await ownerClient.query("SELECT table_name FROM mz_rls_report WHERE status = 'ok' ORDER BY table_name");
    const okTables = tablesRes.rows.map(r => r.table_name);
    console.log(`Found ${okTables.length} active tenant tables in mz_rls_report.`);

    const bothClubsTables = [];
    const emptyTables = [];
    const singleClubTables = [];

    for (const table of okTables) {
      const { rows: counts } = await ownerClient.query(`
        SELECT count(*) FILTER (WHERE club_id = 'GCLUB') AS g_count,
               count(*) FILTER (WHERE club_id = 'TEST-000') AS t_count
          FROM ${table}
      `);
      const gCount = Number(counts[0].g_count);
      const tCount = Number(counts[0].t_count);
      if (gCount > 0 && tCount > 0) {
        bothClubsTables.push(table);
      } else if (gCount === 0 && tCount === 0) {
        emptyTables.push(table);
      } else {
        singleClubTables.push({ table, gCount, tCount });
      }
    }

    console.log(`   ${bothClubsTables.length}/${okTables.length} tables held rows for BOTH clubs ('GCLUB' and 'TEST-000').`);
    console.log(`   Skipped empty tables (${emptyTables.length}):`, emptyTables.length > 0 ? emptyTables.join(", ") : "none");
    if (singleClubTables.length > 0) {
      console.log(`   Single club tables (${singleClubTables.length}):`, singleClubTables.map(s => `${s.table} (G:${s.gCount}, T:${s.tCount})`).join(", "));
    }

    const MINIMUM_DUAL_TENANT_TABLES = 40;
    if (bothClubsTables.length < MINIMUM_DUAL_TENANT_TABLES) {
      console.error(`   FAIL: Fewer than stated minimum (${MINIMUM_DUAL_TENANT_TABLES}) tables held rows for both clubs! Found only ${bothClubsTables.length}`);
      passed = false;
    } else {
      console.log(`   PASS: Stated minimum verified: ${bothClubsTables.length} tables (>= ${MINIMUM_DUAL_TENANT_TABLES}) held rows for both clubs.`);
    }

    let dbLeakCount = 0;
    await withTenant(appPool, "GCLUB", async (c) => {
      for (const table of okTables) {
        const { rows } = await c.query(`SELECT * FROM ${table}`);
        const leaked = rows.filter(r => r.club_id && r.club_id !== "GCLUB");
        if (leaked.length > 0) {
          console.error(`   FAIL: DB table ${table} leaked non-GCLUB rows!`, leaked);
          dbLeakCount++;
        }
      }
    });

    if (dbLeakCount === 0) {
      console.log(`PASS: Zero cross-tenant leaks across all ${okTables.length} tenant tables under withTenant('GCLUB').`);
    } else {
      passed = false;
    }

    // 4. Fail-Closed check (no tenant context set)
    console.log("\n-> 4. Testing fail-closed database behavior (app.club_id is NULL)...");
    const appClient = await appPool.connect();
    try {
      const matchRows = (await appClient.query("SELECT * FROM tg_match WHERE code LIKE 'LEAK_TEST_%'")).rows;
      const playlistRows = (await appClient.query("SELECT * FROM playlist WHERE name LIKE 'LEAK_TEST_%'")).rows;
      if (matchRows.length > 0 || playlistRows.length > 0) {
        console.error("   FAIL: Queries without tenant context returned rows!", { matchRows, playlistRows });
        passed = false;
      } else {
        console.log("PASS: Fail-closed verified (0 rows returned when app.club_id is NULL).");
      }
    } finally {
      appClient.release();
    }

    // 5. Append-Only Denial on ALL tables carrying mz_append_only()
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

    // 6. Test Runtime-Role Guard against Superuser / Owner URL
    console.log("\n-> 6. Testing runtime-role guard against superuser & owner URL...");
    let ownerUrlBlocked = false;
    let ownerErrorMsg = "";
    try {
      resetRoleGuardForTesting();
      // Attempting withTenant on ownerPool (which connects as owner/superuser) must fail
      await withTenant(ownerPool, "GCLUB", async () => {});
    } catch (err) {
      ownerErrorMsg = err.message;
      if (err.message.includes("CRITICAL SECURITY ERROR") || err.message.includes("mz_app")) {
        ownerUrlBlocked = true;
      }
    }

    let appAllowed = false;
    try {
      resetRoleGuardForTesting();
      // withTenant on appPool (role mz_app, no superuser, no BYPASSRLS) must succeed
      await withTenant(appPool, "GCLUB", async (c) => {
        const { rows } = await c.query("SELECT current_user");
        if (rows[0]?.current_user === "mz_app") {
          appAllowed = true;
        }
      });
    } catch (err) {
      console.error("appPool withTenant failed:", err);
    }

    if (ownerUrlBlocked && appAllowed) {
      console.log(`PASS: Runtime-role guard successfully blocked owner URL ('${ownerErrorMsg.trim()}') and permitted mz_app.`);
    } else {
      console.error(`FAIL: Runtime-role guard check failed: ownerUrlBlocked=${ownerUrlBlocked}, appAllowed=${appAllowed}`);
      passed = false;
    }

  } finally {
    console.log("\n-> Cleaning up test fixtures with owner pool...");
    await cleanup(ownerClient, createdTokens);
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
