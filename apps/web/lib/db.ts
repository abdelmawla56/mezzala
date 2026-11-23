// apps/web/lib/db.ts
// Runtime connection pool — connects as mz_app (no DDL, no TRUNCATE, subject to RLS).
// Pool size configurable via DATABASE_POOL_SIZE env var (default 10).
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

// Ensure .env.local is loaded in script/test environments where Next.js hasn't loaded it yet
if (!process.env.DATABASE_URL) {
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

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Add it to .env.local");
}

let roleGuardPromise: Promise<void> | null = null;

export async function assertRuntimeRole(client: { query: (sql: string) => Promise<{ rows: any[] }> }) {
  const res = await client.query(
    `SELECT r.rolname, r.rolsuper, r.rolbypassrls
       FROM pg_roles r
      WHERE r.rolname = current_user`
  );
  if (res.rows.length === 0) {
    throw new Error("assertRuntimeRole: cannot resolve current_user");
  }
  const { rolname, rolsuper, rolbypassrls } = res.rows[0];
  if (rolsuper) {
    throw new Error(`CRITICAL SECURITY ERROR: Runtime pool connected as superuser ('${rolname}'). Must connect as mz_app.`);
  }
  if (rolbypassrls) {
    throw new Error(`CRITICAL SECURITY ERROR: Runtime pool connected with BYPASSRLS ('${rolname}'). Must connect as mz_app.`);
  }
  if (rolname !== "mz_app") {
    throw new Error(`CRITICAL SECURITY ERROR: Runtime role must be 'mz_app', but connected as '${rolname}'.`);
  }
}

export async function ensureRuntimeRoleGuard(client: { query: (sql: string) => Promise<{ rows: any[] }> }) {
  if (!roleGuardPromise) {
    roleGuardPromise = assertRuntimeRole(client).catch((err) => {
      roleGuardPromise = null;
      throw err;
    });
  }
  await roleGuardPromise;
}

export function resetRoleGuardForTesting() {
  roleGuardPromise = null;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  // Catch idle client connection drops to avoid unhandled exceptions
  console.warn("Idle connection closed:", err.message);
});

export default pool;
export { pool };
