// apps/web/lib/db/with-tenant.ts
// Tenant isolation contract. Every query touching tenant data MUST run through withTenant():
// it opens a transaction and sets app.club_id (SET LOCAL), ensuring pooled connections never
// bleed tenant state. Outside it, mz_club() is NULL and every tenant policy returns zero rows.
import type { Pool, PoolClient } from "pg";
import { ensureRuntimeRoleGuard } from "../db.ts";

export const CLUBS = ["GCLUB", "TEST-000"] as const;
export type ClubId = (typeof CLUBS)[number];

export interface TenantUser {
  id?: number;
  clubId?: string;
  role?: string;
}

/**
 * Derives and validates the effective tenant ID for a request.
 * Strictly requires an authenticated user with an assigned club_id.
 * Rejects anonymous access and prevents tenant spoofing.
 */
export function tenantFor(
  user?: TenantUser | null,
  requestedClubId?: string | null
): string {
  if (!user) {
    throw new Error("UNAUTHORIZED: Authentication required");
  }
  if (!user.clubId) {
    throw new Error("FORBIDDEN: User has no assigned club membership");
  }
  if (requestedClubId && requestedClubId !== user.clubId) {
    throw new Error(`FORBIDDEN: User of '${user.clubId}' cannot access tenant '${requestedClubId}'`);
  }
  return user.clubId;
}

/**
 * Executes a callback within an explicit tenant transaction.
 * Sets app.club_id locally to prevent connection pool leakage.
 * Awaits runtime-role guard on the first call to guarantee non-superuser, non-BYPASSRLS mz_app role.
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
    await ensureRuntimeRoleGuard(c);
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
