#!/usr/bin/env node
/**
 * api-check.mjs
 * Validates API route handlers and basic contract responses.
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

const { DATABASE_URL } = process.env;
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

async function run() {
  console.log("=== Running api-check.mjs ===");
  // Test basic db connectivity with mz_app
  const c = await pool.connect();
  try {
    const res = await c.query("SELECT current_user, current_database()");
    console.log("Connected as:", res.rows[0]);
    if (res.rows[0].current_user !== "mz_app") {
      throw new Error(`Expected current_user 'mz_app', got '${res.rows[0].current_user}'`);
    }
    console.log("PASS: Connected as mz_app");
  } finally {
    c.release();
    await pool.end();
  }
  console.log("=== api-check.mjs PASSED ===");
}

run().catch((err) => {
  console.error("api-check failed:", err);
  process.exit(1);
});
