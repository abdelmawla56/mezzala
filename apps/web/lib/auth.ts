// apps/web/lib/auth.ts
import { createHash } from "node:crypto";
import pool from "./db.ts";
import { tenantFor, type TenantUser } from "./db/with-tenant.ts";

export interface AuthContext {
  user: TenantUser | null;
  clubId: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function getAuthContext(req: Request): Promise<AuthContext> {
  let user: TenantUser | null = null;

  // 1. Check Bearer token
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const rawToken = authHeader.slice(7).trim();
    const tokenHash = hashToken(rawToken);

    // sessions & users are exempt tables in mz_rls_exempt
    const res = await pool.query(
      `SELECT u.id, u.email, u.role, u.club_id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash]
    );

    if (res.rows.length > 0) {
      const row = res.rows[0];
      user = { id: row.id, role: row.role, clubId: row.club_id };
    }
  }

  // 2. Direct test headers fallback (for scripts/tests)
  const headerClub = req.headers.get("x-club-id");
  const headerUser = req.headers.get("x-user-id");
  if (!user && headerUser) {
    user = { id: Number(headerUser), clubId: headerClub ?? undefined };
  }

  // 3. Resolve authoritative tenant via tenantFor
  const clubId = tenantFor(user, headerClub);

  return { user, clubId };
}
