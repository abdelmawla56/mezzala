// apps/web/app/api/qa/route.ts
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
      `SELECT qd.id, qd.annotation_id, qd.decision FROM qa_decision qd
         JOIN annotation a ON a.id = qd.annotation_id
        WHERE a.match_id = $1 ORDER BY qd.id DESC`,
      [matchId]
    );
    return rows;
  });
  return NextResponse.json({ rows });
}
