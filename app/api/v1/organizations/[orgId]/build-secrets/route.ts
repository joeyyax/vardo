import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { listBuildSecrets } from "@/lib/build-secrets/store";

type RouteParams = { params: Promise<{ orgId: string }> };

// GET — the org's build secret names; values are never returned
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.buildSecrets.manage");
    if (!org) return apiError.forbidden();
    return NextResponse.json({ buildSecrets: await listBuildSecrets(orgId) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/build-secrets" });
