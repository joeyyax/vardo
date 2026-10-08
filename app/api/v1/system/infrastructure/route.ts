import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextResponse } from "next/server";

import { apiError, handleRouteError } from "@/lib/api/error-response";
import { getInfrastructureSnapshot } from "@/lib/attention/infrastructure";
import { hasSelfDeploy, infrastructureRows } from "@/lib/attention/infrastructure-rows";
import { getSession } from "@/lib/auth/session";

/**
 * GET — state of Vardo's own stack and the shared core services.
 * Platform-level and tenant-free, so any authenticated session may read it.
 */
async function handleGet() {
  try {
    const session = await getSession();
    if (!session) return apiError.unauthorized();

    const snapshot = await getInfrastructureSnapshot();
    const rows = infrastructureRows(snapshot, {
      canLinkToAdmin: !!session.user?.isAppAdmin,
    });

    return NextResponse.json({ rows, selfDeploy: hasSelfDeploy(rows) });
  } catch (error) {
    return handleRouteError(error, "Error reading infrastructure status");
  }
}

export const GET = withRateLimit(handleGet, { tier: "poll", key: "get:v1/system/infrastructure" });
