import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requireAdminAuth } from "@/lib/auth/admin";
import { uptimeClient } from "@/lib/uptime/client";

// GET — vantage points and the uptime switches on each mesh link
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const [vantages, links] = await Promise.all([uptimeClient.listVantages(), uptimeClient.listVantageLinks()]);
    return NextResponse.json({ vantages, links });
  } catch (error) {
    return handleRouteError(error, "Error listing vantage points");
  }
}

export const GET = withRateLimit(handleGet, { tier: "admin", key: "get:v1/admin/uptime/vantages" });
