// apps/web/lib/db/with-tenant.ts
// Tenant isolation contract. Every query touching tenant data MUST run through withTenant():
// it opens a transaction and sets app.club_id (SET LOCAL), ensuring pooled connections never
// bleed tenant state. Outside it, mz_club() is NULL and every tenant policy returns zero rows.
import type { Pool, PoolClient } from "pg";

export const CLUBS = ["GCLUB", "TEST-000"] as const;
export type ClubId = (typeof CLUBS)[number];

export interface TenantUser {
  id?: number;
  clubId?: string;
  role?: string;
}

/**
 * Derives and validates the effective tenant ID for a request.
 * Enforces that user cannot access another tenant's data.
 */
export function tenantFor(
  user?: TenantUser | null,
  requestedClubId?: string | null
): string {
  if (user?.clubId) {
    if (requestedClubId && requestedClubId !== user.clubId && user.role !== "superadmin") {
      throw new Error(`tenantFor: unauthorized access to club '${requestedClubId}' by user of '${user.clubId}'`);
    }
    return user.clubId;
  }
  if (requestedClubId && (CLUBS as readonly string[]).includes(requestedClubId)) {
    return requestedClubId;
  }
  throw new Error(`tenantFor: invalid or missing club id '${requestedClubId}'`);
}

/**
 * Executes a callback within an explicit tenant transaction.
 * Sets app.club_id locally to prevent connection pool leakage.
 */
export async function withTenant<T>(
  pool: Pool,
  clubId: string,
  fn: (c: PoolClient) => Promise<T>
): Promise<T> {
  if (!clubId || typeof clubId !== "string") {
    throw new Error("withTenant: club id required");
  }
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
