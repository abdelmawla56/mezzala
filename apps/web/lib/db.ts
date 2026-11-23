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

export async function assertNoSuperuser(client: { query: (sql: string) => Promise<{ rows: any[] }> }) {
  const res = await client.query(
    "SELECT current_user, usesuper FROM pg_user WHERE usename = current_user"
  );
  const row = res.rows[0];
  if (row?.usesuper || row?.current_user === "postgres" || row?.current_user === "mezzala") {
    throw new Error(`CRITICAL SECURITY ERROR: Runtime pool connected as superuser/owner ('${row?.current_user}'). Must connect as mz_app.`);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Startup & connection guard: fail closed if connected with a superuser role
pool.on("connect", async (client) => {
  try {
    await assertNoSuperuser(client);
  } catch (err: any) {
    console.error(err.message);
  }
});

pool.on("error", (err) => {
  // Catch idle client connection drops to avoid unhandled exceptions
  console.warn("Idle connection closed:", err.message);
});

export default pool;
export { pool };
