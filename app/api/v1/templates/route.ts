import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireSession } from "@/lib/auth/session";
import { requirePlugin } from "@/lib/api/require-plugin";
import { loadTemplates } from "@/lib/templates/load";

// GET /api/v1/templates
async function handleGet(_request: NextRequest) {
  try {
    await requireSession();

    const gate = await requirePlugin("templates");
    if (gate) return gate;

    const templates = await loadTemplates();
    return NextResponse.json({ templates });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/templates" });
