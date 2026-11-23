// apps/web/app/api/auth/login/route.ts
import pool from "../../../../lib/db.ts";

// Magic-link login (no SSO). Rate limiting and lockout in Task 4.
export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return Response.json({ error: "content_type_required" }, { status: 415 });
  }
  const { email } = await req.json().catch(() => ({}));
  if (!email) return Response.json({ error: "email_required" }, { status: 400 });
  return Response.json({ ok: true, message: "magic link sent (stub)" });
}
