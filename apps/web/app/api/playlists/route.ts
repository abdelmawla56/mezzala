// apps/web/app/api/playlists/route.ts
import { NextRequest, NextResponse } from "next/server";
import pool from "../../../lib/db";
import { withTenant } from "../../../lib/db/with-tenant";

export async function GET(req: NextRequest) {
  const clubId = req.headers.get("x-club-id") ?? "";
  if (!clubId) return NextResponse.json({ error: "missing club" }, { status: 400 });
  const rows = await withTenant(pool, clubId, async (c) => {
    const { rows } = await c.query(`SELECT id, name, created_at FROM playlist ORDER BY created_at DESC`);
    return rows;
  });
  return NextResponse.json({ rows });
}
