// apps/web/app/api/qa/route.ts
import pool from "../../../lib/db.ts";
import { withTenant } from "../../../lib/db/with-tenant.ts";
import { getAuthContext } from "../../../lib/auth.ts";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const matchId = Number(searchParams.get("match_id") ?? 0);
    if (!matchId) {
      return Response.json({ error: "missing_match_id" }, { status: 400 });
    }

    const { clubId } = await getAuthContext(req);

    // Defense in depth: RLS enforces club_id = mz_club(), and SQL query explicitly binds a.club_id = $2
    const rows = await withTenant(pool, clubId, async (c) => {
      const { rows } = await c.query(
        `SELECT qd.id, qd.club_id, qd.annotation_id, qd.decision, qd.decided_at
           FROM qa_decision qd
           JOIN annotation a ON a.id = qd.annotation_id
          WHERE a.match_id = $1 AND a.club_id = $2
          ORDER BY qd.id DESC`,
        [matchId, clubId]
      );
      return rows;
    });

    return Response.json({ rows });
  } catch (err: any) {
    const status = err.message?.includes("unauthorized") ? 403 : 400;
    return Response.json({ error: err.message }, { status });
  }
}
