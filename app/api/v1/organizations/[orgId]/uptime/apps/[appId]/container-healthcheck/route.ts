import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { adoptContainerHealthcheck } from "@/lib/uptime/health";

type RouteParams = { params: Promise<{ orgId: string; appId: string }> };

/** POST — add a healthcheck on the uptime health path to the app's compose file. Takes effect on the next deploy. */
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.config");
    if (!app) return apiError.notFound("app");
    if (!(await adoptContainerHealthcheck(orgId, appId))) {
      return NextResponse.json({ error: "There's no health path to add, or the app already has a healthcheck." }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error adding the container healthcheck");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-uptime-container-healthcheck" });
