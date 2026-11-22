// apps/web/app/api/media/route.ts
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
      `SELECT id, filename, s3_key, bytes, duration_ms, upload_state FROM media_asset WHERE match_id = $1`,
      [matchId]
    );
    return rows;
  });
  return NextResponse.json({ rows });
}
