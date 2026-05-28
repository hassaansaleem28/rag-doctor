import { NextRequest, NextResponse } from "next/server";
import { callCoralTool } from "@/lib/coral";

export async function POST(req: NextRequest) {
  try {
    const { sql } = await req.json();
    if (!sql)
      return NextResponse.json({ error: "Missing sql" }, { status: 400 });

    const result = await callCoralTool("sql", { sql });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content?.[0]?.text || "{}";
    const parsed = JSON.parse(text);

    return NextResponse.json({ rows: parsed.rows || [], sql });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
