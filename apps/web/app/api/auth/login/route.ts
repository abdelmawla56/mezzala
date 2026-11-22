// apps/web/app/api/auth/login/route.ts
import { NextRequest, NextResponse } from "next/server";
import pool from "../../../../lib/db";
import { withTenant } from "../../../../lib/db/with-tenant";

// Magic-link login (no SSO). Rate limiting and lockout to be added in Task 4.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ error: "content_type_required" }, { status: 415 });
  }
  const { email } = await req.json();
  if (!email) return NextResponse.json({ error: "email_required" }, { status: 400 });
  // TODO Task 4: rate limiting / lockout
  return NextResponse.json({ ok: true, message: "magic link sent (stub)" });
}
