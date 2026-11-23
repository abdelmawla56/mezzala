// apps/web/app/api/tagging/route.ts
import pool from "../../../lib/db.ts";
import { withTenant } from "../../../lib/db/with-tenant.ts";
import { getAuthContext } from "../../../lib/auth.ts";

export async function GET(req: Request) {
  try {
    const { clubId } = await getAuthContext(req);

    const { searchParams } = new URL(req.url);
    const matchId = Number(searchParams.get("match_id") ?? 0);
    if (!matchId) {
      return Response.json({ error: "missing_match_id" }, { status: 400 });
    }

    // Explicit lookup of the match first for the current tenant
    const matchExists = await withTenant(pool, clubId, async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM tg_match WHERE id = $1 AND club_id = $2`,
        [matchId, clubId]
      );
      return rows.length > 0;
    });

    if (!matchExists) {
      return Response.json({ error: "match_not_found" }, { status: 404 });
    }

    const rows = await withTenant(pool, clubId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.club_id, ar.rev, ar.match_ms, ar.payload
           FROM annotation a
           JOIN annotation_revision ar ON ar.annotation_id = a.id
          WHERE a.match_id = $1
            AND a.club_id = $2
            AND ar.rev = (SELECT max(r.rev) FROM annotation_revision r WHERE r.annotation_id = a.id)
          ORDER BY ar.match_ms ASC`,
        [matchId, clubId]
      );
      return rows;
    });

    return Response.json({ rows });
  } catch (err: any) {
    const status = err.message?.includes("UNAUTHORIZED")
      ? 401
      : err.message?.includes("FORBIDDEN")
      ? 403
      : 400;
    return Response.json({ error: err.message }, { status });
  }
}
