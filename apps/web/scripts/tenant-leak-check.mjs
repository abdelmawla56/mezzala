#!/usr/bin/env node
/**
 * tenant-leak-check.mjs
 * Key acceptance test for Task 1 (Row-Level Security & Tenant Isolation).
 *
 * Checks:
 * 1. Isolation: Under withTenant('GCLUB'), queries against tenant tables never see TEST-000 rows.
 * 2. Fail-Closed: Direct query without setting app.club_id returns 0 rows on tenant tables.
 * 3. Append-Only Enforcement: mz_app role is strictly denied UPDATE / DELETE / TRUNCATE on append-only tables.
 * 4. Cleanup: Uses DATABASE_URL_OWNER with session_replication_role = 'replica' to clean up fixtures.
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

async function cleanup(ownerClient) {
  try {
    await ownerClient.query("SET session_replication_role = 'replica'");
    await ownerClient.query("DELETE FROM annotation_revision WHERE club_id IN ('GCLUB', 'TEST-000') AND match_ms = 1000");
    await ownerClient.query("DELETE FROM annotation WHERE match_id IN (SELECT id FROM tg_match WHERE code LIKE 'LEAK_TEST_%')");
    await ownerClient.query("DELETE FROM playlist WHERE name LIKE 'LEAK_TEST_%'");
    await ownerClient.query("DELETE FROM tg_match WHERE code LIKE 'LEAK_TEST_%'");
  } finally {
    await ownerClient.query("SET session_replication_role = 'origin'").catch(() => {});
  }
}

async function run() {
  console.log("=== Running tenant-leak-check.mjs ===");
  let passed = true;

  const ownerClient = await ownerPool.connect();
  try {
    // 0. Ensure tenants exist
    await ownerClient.query("INSERT INTO tenant (id, name) VALUES ('GCLUB', 'Golden Club') ON CONFLICT DO NOTHING");
    await ownerClient.query("INSERT INTO tenant (id, name) VALUES ('TEST-000', 'Test Tenant') ON CONFLICT DO NOTHING");

    // Clean up any existing fixtures
    await cleanup(ownerClient);

    // 1. Insert test data for both tenants via owner
    console.log("-> Seeding test fixtures for GCLUB and TEST-000...");
    const gMatch = await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('GCLUB', 'LEAK_TEST_G', CURRENT_DATE, 'GHome', 'GAway') RETURNING id"
    );
    const tMatch = await ownerClient.query(
      "INSERT INTO tg_match (club_id, code, match_date, home_team, away_team) VALUES ('TEST-000', 'LEAK_TEST_T', CURRENT_DATE, 'THome', 'TAway') RETURNING id"
    );

    const gMatchId = gMatch.rows[0].id;
    const tMatchId = tMatch.rows[0].id;

    await ownerClient.query(
      "INSERT INTO playlist (club_id, name) VALUES ('GCLUB', 'LEAK_TEST_PLAYLIST_G'), ('TEST-000', 'LEAK_TEST_PLAYLIST_T')"
    );

    // 2. Query as mz_app within GCLUB context
    console.log("-> Testing RLS boundary under withTenant('GCLUB')...");
    await withTenant(appPool, "GCLUB", async (c) => {
      const matchRows = (await c.query("SELECT id, club_id, code FROM tg_match WHERE code LIKE 'LEAK_TEST_%'")).rows;
      const test000Matches = matchRows.filter(r => r.club_id === "TEST-000");
      if (test000Matches.length > 0) {
        console.error("FAIL: GCLUB session saw TEST-000 match!", test000Matches);
        passed = false;
      } else {
        console.log(`PASS: GCLUB sees only GCLUB matches (${matchRows.length} found, 0 from TEST-000)`);
      }

      const playlistRows = (await c.query("SELECT id, club_id, name FROM playlist WHERE name LIKE 'LEAK_TEST_%'")).rows;
      const test000Playlists = playlistRows.filter(r => r.club_id === "TEST-000");
      if (test000Playlists.length > 0) {
        console.error("FAIL: GCLUB session saw TEST-000 playlist!", test000Playlists);
        passed = false;
      } else {
        console.log(`PASS: GCLUB sees only GCLUB playlists (${playlistRows.length} found, 0 from TEST-000)`);
      }
    });

    // 3. Fail-Closed check: query as mz_app WITHOUT withTenant (app.club_id is NULL)
    console.log("-> Testing fail-closed behavior (app.club_id is NULL)...");
    const appClient = await appPool.connect();
    try {
      const rows = (await appClient.query("SELECT * FROM tg_match WHERE code LIKE 'LEAK_TEST_%'")).rows;
      if (rows.length !== 0) {
        console.error("FAIL: Direct query without tenant context returned rows:", rows);
        passed = false;
      } else {
        console.log("PASS: Direct query returned 0 rows (fail-closed verified)");
      }
    } finally {
      appClient.release();
    }

    // 4. Append-Only Denial Check
    console.log("-> Testing append-only permission denial on mz_app...");
    // Create an annotation and revision in GCLUB context
    const annRes = await ownerClient.query(
      "INSERT INTO annotation (club_id, match_id) VALUES ('GCLUB', $1) RETURNING id",
      [gMatchId]
    );
    const annId = annRes.rows[0].id;

    const revRes = await ownerClient.query(
      "INSERT INTO annotation_revision (club_id, annotation_id, rev, match_ms, payload) VALUES ('GCLUB', $1, 1, 1000, '{\"type\":\"tag\"}') RETURNING id",
      [annId]
    );
    const revId = revRes.rows[0].id;

    // UPDATE denial test
    let updateBlocked = false;
    try {
      await withTenant(appPool, "GCLUB", async (c) => {
        await c.query("UPDATE annotation_revision SET match_ms = 9999 WHERE id = $1", [revId]);
      });
    } catch (err) {
      if (err.message.includes("permission denied") || err.code === "42501" || err.message.includes("append-only")) {
        updateBlocked = true;
      }
    }
    if (updateBlocked) {
      console.log("PASS: mz_app UPDATE on annotation_revision denied");
    } else {
      console.error("FAIL: mz_app UPDATE on annotation_revision was NOT denied!");
      passed = false;
    }

    // DELETE denial test
    let deleteBlocked = false;
    try {
      await withTenant(appPool, "GCLUB", async (c) => {
        await c.query("DELETE FROM annotation_revision WHERE id = $1", [revId]);
      });
    } catch (err) {
      if (err.message.includes("permission denied") || err.code === "42501" || err.message.includes("append-only")) {
        deleteBlocked = true;
      }
    }
    if (deleteBlocked) {
      console.log("PASS: mz_app DELETE on annotation_revision denied");
    } else {
      console.error("FAIL: mz_app DELETE on annotation_revision was NOT denied!");
      passed = false;
    }

    // TRUNCATE denial test
    let truncateBlocked = false;
    try {
      await withTenant(appPool, "GCLUB", async (c) => {
        await c.query("TRUNCATE TABLE annotation_revision");
      });
    } catch (err) {
      if (err.message.includes("permission denied") || err.code === "42501") {
        truncateBlocked = true;
      }
    }
    if (truncateBlocked) {
      console.log("PASS: mz_app TRUNCATE on annotation_revision denied");
    } else {
      console.error("FAIL: mz_app TRUNCATE on annotation_revision was NOT denied!");
      passed = false;
    }

  } finally {
    console.log("-> Cleaning up test fixtures with owner pool...");
    await cleanup(ownerClient);
    ownerClient.release();
    await appPool.end();
    await ownerPool.end();
  }

  if (passed) {
    console.log("=== ALL TENANT LEAK & PERMISSION CHECKS PASSED ===");
    process.exit(0);
  } else {
    console.error("=== SOME CHECKS FAILED ===");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
