// apps/web/app/api/tagging/route.ts
import { NextRequest, NextResponse } from "next/server";
import pool from "../../../lib/db";
import { withTenant } from "../../../lib/db/with-tenant";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const clubId = req.headers.get("x-club-id") ?? "";
  const matchId = Number(searchParams.get("match_id") ?? 0);
  if (!clubId || !matchId) return NextResponse.json({ error: "missing params" }, { status: 400 });
  const rows = await withTenant(pool, clubId, async (c) => {
    const { rows } = await c.query(
      `SELECT a.id, ar.rev, ar.match_ms, ar.payload FROM annotation a
         JOIN annotation_revision ar ON ar.annotation_id = a.id
        WHERE a.match_id = $1 AND ar.rev = (SELECT max(r.rev) FROM annotation_revision r WHERE r.annotation_id = a.id)`,
      [matchId]
    );
    return rows;
  });
  return NextResponse.json({ rows });
}
