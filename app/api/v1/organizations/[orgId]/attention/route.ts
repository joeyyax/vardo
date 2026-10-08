import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";

import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { buildAttentionRows } from "@/lib/attention/rows";
import { getSession } from "@/lib/auth/session";

type RouteParams = { params: Promise<{ orgId: string }> };

// GET — every notice for this org, for the chrome that renders on every page.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    const session = await getSession();
    const rows = await buildAttentionRows(orgId, {
      isAppAdmin: !!session?.user?.isAppAdmin,
    });

    return NextResponse.json({ rows });
  } catch (error) {
    return handleRouteError(error, "Error reading attention rows");
  }
}

export const GET = withRateLimit(handleGet, { tier: "poll", key: "get:v1/organizations/*/attention" });
