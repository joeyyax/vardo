import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { loadTemplates } from "@/lib/templates/load";

// GET /api/v1/templates
export async function GET(_request: NextRequest) {
  try {
    await requireSession();
    const templates = await loadTemplates();
    return NextResponse.json({ templates });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
