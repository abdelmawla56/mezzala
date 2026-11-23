// apps/web/lib/db-owner.ts
// Owner-role pool for migrations, seeding, and test cleanup ONLY.
// MUST NOT be imported from app/ or lib/ request paths.
// Accepts DATABASE_URL_OWNER (superuser / migration role).
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

// Import guard: ensure owner pool is never imported into request handlers
const stack = new Error().stack || "";
if (
  process.env.NEXT_RUNTIME ||
  stack.includes("/app/api/") ||
  stack.includes("\\app\\api\\") ||
  stack.includes("/apps/web/app/") ||
  stack.includes("\\apps\\web\\app\\")
) {
  throw new Error("SECURITY VIOLATION: db-owner.ts must NOT be imported from app/ or lib/ request paths");
}

if (!process.env.DATABASE_URL_OWNER) {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.resolve(__dirname, "../.env.local");
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, "utf8").split("\n");
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
  } catch {}
}

if (!process.env.DATABASE_URL_OWNER) {
  throw new Error("DATABASE_URL_OWNER is not set");
}

export const ownerPool = new Pool({
  connectionString: process.env.DATABASE_URL_OWNER,
  max: 2, // minimal; only scripts use this
  idleTimeoutMillis: 10_000,
});
