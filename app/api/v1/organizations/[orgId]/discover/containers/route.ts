import { NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requireAppAdmin } from "@/lib/auth/admin";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { discoverContainers } from "@/lib/docker/discover";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/discover/containers
async function handleGet(_request: Request, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "app.import");
    if (!org) return apiError.forbidden();
    await requireAppAdmin();

    const gate = await requirePlugin("container-import");
    if (gate) return gate;

    const result = await discoverContainers();
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error discovering containers");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "discover" });
