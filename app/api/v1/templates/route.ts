import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireSession } from "@/lib/auth/session";
import { loadTemplates } from "@/lib/templates/load";

// GET /api/v1/templates
export async function GET(_request: NextRequest) {
  try {
    await requireSession();
    const templates = await loadTemplates();
    return NextResponse.json({ templates });
  } catch (error) {
    return handleRouteError(error);
  }
}
