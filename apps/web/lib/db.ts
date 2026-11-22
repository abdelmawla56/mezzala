// apps/web/lib/db.ts
// Runtime connection pool — connects as mz_app (no DDL, no TRUNCATE, subject to RLS).
// Pool size configurable via DATABASE_POOL_SIZE env var (default 10).
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Add it to .env.local");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export default pool;
export { pool };
