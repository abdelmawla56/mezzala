// apps/web/app/api/playlists/route.ts
import pool from "../../../lib/db.ts";
import { withTenant } from "../../../lib/db/with-tenant.ts";
import { getAuthContext } from "../../../lib/auth.ts";

export async function GET(req: Request) {
  try {
    const { clubId } = await getAuthContext(req);

    // Defense in depth: RLS enforces club_id = mz_club(), and SQL explicitly filters by club_id = $1
    const rows = await withTenant(pool, clubId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, club_id, name, created_at
           FROM playlist
          WHERE club_id = $1
          ORDER BY created_at DESC`,
        [clubId]
      );
      return rows;
    });

    return Response.json({ rows });
  } catch (err: any) {
    const status = err.message?.includes("unauthorized") ? 403 : 400;
    return Response.json({ error: err.message }, { status });
  }
}
