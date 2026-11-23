// apps/web/app/api/ai-tagging/route.ts
import { getAuthContext } from "../../../lib/auth.ts";

export async function GET(req: Request) {
  try {
    await getAuthContext(req);
  } catch (err: any) {
    const status = err.message?.includes("FORBIDDEN") ? 403 : 401;
    return Response.json({ error: err.message }, { status });
  }
  return Response.json(
    {
      error: "no_vendor",
      message_en: "No AI tagging vendor connected yet",
      message_ar: "لا يوجد مورد وسم ذكاء اصطناعي متصل بعد"
    },
    { status: 409 }
  );
}

export async function POST(req: Request) {
  try {
    await getAuthContext(req);
  } catch (err: any) {
    const status = err.message?.includes("FORBIDDEN") ? 403 : 401;
    return Response.json({ error: err.message }, { status });
  }
  return Response.json(
    {
      error: "no_vendor",
      message_en: "No AI tagging vendor connected yet",
      message_ar: "لا يوجد مورد وسم ذكاء اصطناعي متصل بعد"
    },
    { status: 409 }
  );
}
