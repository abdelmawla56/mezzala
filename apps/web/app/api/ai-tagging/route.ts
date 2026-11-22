// apps/web/app/api/ai-tagging/route.ts
import { NextRequest, NextResponse } from "next/server";

// AI tagging vendor is NOT connected yet (gap open). Always returns 409 no_vendor.
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    { error: "no_vendor", message_en: "No AI tagging vendor connected yet", message_ar: "لا يوجد مورد وسم ذكاء اصطناعي متصل بعد" },
    { status: 409 }
  );
}
