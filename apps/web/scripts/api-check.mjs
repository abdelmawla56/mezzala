#!/usr/bin/env node
/**
 * api-check.mjs
 * End-to-end API surface & contract verification across all routes.
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

import { POST as loginPOST } from "../app/api/auth/login/route.ts";
import { GET as taggingGET } from "../app/api/tagging/route.ts";
import { GET as mediaGET } from "../app/api/media/route.ts";
import { GET as qaGET } from "../app/api/qa/route.ts";
import { GET as playlistsGET } from "../app/api/playlists/route.ts";
import { GET as aiGET, POST as aiPOST } from "../app/api/ai-tagging/route.ts";

async function run() {
  console.log("=== Running api-check.mjs ===");

  // 1. Database connection role verification
  const c = await pool.connect();
  try {
    const res = await c.query("SELECT current_user, usesuper FROM pg_user WHERE usename = current_user");
    const { current_user, usesuper } = res.rows[0];
    if (current_user !== "mz_app") {
      throw new Error(`Expected current_user 'mz_app', got '${current_user}'`);
    }
    if (usesuper) {
      throw new Error("CRITICAL: mz_app must NOT have superuser privileges!");
    }
    console.log(`PASS: Connected as non-superuser role '${current_user}'`);
  } finally {
    c.release();
    await pool.end();
  }

  // 2. Auth Route: /api/auth/login
  // Enforce application/json Content-Type
  const badCtReq = new Request("http://localhost:3600/api/auth/login", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "email=user@test.dev"
  });
  const badCtRes = await loginPOST(badCtReq);
  if (badCtRes.status !== 415) {
    throw new Error(`Expected 415 on invalid Content-Type, got ${badCtRes.status}`);
  }

  // Missing email
  const missingEmailReq = new Request("http://localhost:3600/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const missingEmailRes = await loginPOST(missingEmailReq);
  if (missingEmailRes.status !== 400) {
    throw new Error(`Expected 400 on missing email, got ${missingEmailRes.status}`);
  }

  // Valid login request
  const validLoginReq = new Request("http://localhost:3600/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@gclub.dev" })
  });
  const validLoginRes = await loginPOST(validLoginReq);
  if (validLoginRes.status !== 200) {
    throw new Error(`Expected 200 on valid login, got ${validLoginRes.status}`);
  }
  console.log("PASS: /api/auth/login Content-Type and validation verified");

  // 3. Missing params check on tenant routes
  const noMatchTagging = await taggingGET(new Request("http://localhost:3600/api/tagging", { headers: { "x-club-id": "GCLUB" } }));
  if (noMatchTagging.status !== 400) throw new Error("Expected 400 on missing match_id");

  const noMatchMedia = await mediaGET(new Request("http://localhost:3600/api/media", { headers: { "x-club-id": "GCLUB" } }));
  if (noMatchMedia.status !== 400) throw new Error("Expected 400 on missing match_id");

  const noMatchQA = await qaGET(new Request("http://localhost:3600/api/qa", { headers: { "x-club-id": "GCLUB" } }));
  if (noMatchQA.status !== 400) throw new Error("Expected 400 on missing match_id");

  console.log("PASS: Parameter validation verified on /api/tagging, /api/media, /api/qa");

  // 4. Missing tenant / unauthenticated check
  const noClubPlaylists = await playlistsGET(new Request("http://localhost:3600/api/playlists"));
  if (noClubPlaylists.status !== 401) throw new Error(`Expected 401 on unauthenticated request, got ${noClubPlaylists.status}`);
  console.log("PASS: Authentication requirement verified on /api/playlists (401 Unauthorized)");

  // 5. AI Tagging contract verification
  const aiGet = await aiGET(new Request("http://localhost:3600/api/ai-tagging"));
  if (aiGet.status !== 409) throw new Error("Expected 409 on AI tagging");

  const aiPost = await aiPOST(new Request("http://localhost:3600/api/ai-tagging", { method: "POST" }));
  if (aiPost.status !== 409) throw new Error("Expected 409 on AI tagging POST");
  console.log("PASS: AI tagging 409 contract verified");

  console.log("=== api-check.mjs PASSED ===");
}

run().catch((err) => {
  console.error("api-check failed:", err);
  process.exit(1);
});
