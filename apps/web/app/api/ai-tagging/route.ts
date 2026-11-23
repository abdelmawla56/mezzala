// apps/web/app/api/ai-tagging/route.ts
export async function GET(_req: Request) {
  return Response.json(
    {
      error: "no_vendor",
      message_en: "No AI tagging vendor connected yet",
      message_ar: "لا يوجد مورد وسم ذكاء اصطناعي متصل بعد"
    },
    { status: 409 }
  );
}

export async function POST(_req: Request) {
  return Response.json(
    {
      error: "no_vendor",
      message_en: "No AI tagging vendor connected yet",
      message_ar: "لا يوجد مورد وسم ذكاء اصطناعي متصل بعد"
    },
    { status: 409 }
  );
}
