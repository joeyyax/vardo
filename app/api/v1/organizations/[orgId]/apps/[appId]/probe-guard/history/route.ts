import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { guardHistory } from "@/lib/probe-guard/history";
import { parseGuardRange } from "@/lib/probe-guard/range";

type RouteParams = { params: Promise<{ orgId: string; appId: string }> };

/** GET — this app's counts, bans, probed categories and top sources for `?range=`. */
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.view");
    if (!app) return apiError.forbidden();
    const history = await guardHistory({ range: parseGuardRange(request.nextUrl.searchParams.get("range")), appId });
    return NextResponse.json({ ...history, appNames: {} });
  } catch (error) {
    return handleRouteError(error, "Error reading probe guard history");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/probe-guard/history" });
