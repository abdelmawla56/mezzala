// apps/web/lib/db-owner.ts
// Owner-role pool for migrations, seeding, and test cleanup ONLY.
// MUST NOT be imported from app/ or lib/ request paths.
// Accepts DATABASE_URL_OWNER (superuser / migration role).
import { Pool } from "pg";

if (!process.env.DATABASE_URL_OWNER) {
  throw new Error("DATABASE_URL_OWNER is not set");
}

export const ownerPool = new Pool({
  connectionString: process.env.DATABASE_URL_OWNER,
  max: 2, // minimal; only scripts use this
  idleTimeoutMillis: 10_000,
});
