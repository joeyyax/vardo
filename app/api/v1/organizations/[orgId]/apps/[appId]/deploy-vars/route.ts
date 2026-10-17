import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { servingDeployVars } from "@/lib/docker/serving-deploy-vars";
import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/deploy-vars[?environmentId=]
// The variables Vardo set on the serving deploy. `vars` is null before the first deploy that recorded them.
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "env.read");
    if (!app) return apiError.notFound("app");

    const serving = await servingDeployVars(appId, request.nextUrl.searchParams.get("environmentId"));
    return NextResponse.json({ deploymentId: serving?.deploymentId ?? null, vars: serving?.vars ?? null });
  } catch (error) {
    return handleRouteError(error, "Error fetching deploy variables");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/deploy-vars" });
