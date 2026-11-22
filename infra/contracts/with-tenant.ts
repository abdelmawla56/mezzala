// Reference implementation of the tenant contract. Copy to apps/web/lib/db/with-tenant.ts.
// Every query that touches tenant data MUST run through withTenant(): it opens a transaction and sets
// app.club_id for that transaction only (set_config(..., true) == SET LOCAL), so a pooled connection
// never carries one tenant's context into the next request. Outside it, mz_club() is NULL and every
// tenant policy returns zero rows (fail closed).
import type { Pool, PoolClient } from "pg";

export const CLUBS = ["GCLUB", "TEST-000"] as const;
export type ClubId = (typeof CLUBS)[number];

export async function withTenant<T>(pool: Pool, clubId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (!clubId || typeof clubId !== "string") throw new Error("withTenant: club id required");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.club_id', $1, true)", [clubId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
