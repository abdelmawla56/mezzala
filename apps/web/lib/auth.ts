// apps/web/lib/auth.ts
import { createHash } from "node:crypto";
import pool from "./db.ts";
import { tenantFor, type TenantUser } from "./db/with-tenant.ts";

export interface AuthContext {
  user: TenantUser;
  clubId: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Extracts session from cookie or Authorization header, validates against sessions table,
 * checks expiration, and resolves the tenant via tenantFor(user).
 * Throws UNAUTHORIZED (401) or FORBIDDEN (403) on failure.
 */
export async function getAuthContext(req: Request): Promise<AuthContext> {
  let rawToken: string | null = null;

  // 1. Extract from Cookie header
  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map((c) => {
        const [k, ...v] = c.trim().split("=");
        return [k, v.join("=")];
      })
    );
    rawToken = cookies["mz_session"] || cookies["session_token"] || null;
  }

  // 2. Extract from Authorization Bearer header
  if (!rawToken) {
    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      rawToken = authHeader.slice(7).trim();
    }
  }

  if (!rawToken) {
    throw new Error("UNAUTHORIZED: missing session cookie or token");
  }

  const tokenHash = hashToken(rawToken);

  // Query sessions table (exempt from RLS)
  const res = await pool.query(
    `SELECT u.id, u.email, u.role, u.club_id, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [tokenHash]
  );

  if (res.rows.length === 0) {
    throw new Error("UNAUTHORIZED: session not found or invalid");
  }

  const session = res.rows[0];
  if (new Date(session.expires_at) <= new Date()) {
    throw new Error("UNAUTHORIZED: session expired");
  }

  const user: TenantUser = {
    id: session.id,
    role: session.role,
    clubId: session.club_id ?? undefined,
  };

  const clientClubHeader = req.headers.get("x-club-id");
  const clubId = tenantFor(user, clientClubHeader);

  return { user, clubId };
}
