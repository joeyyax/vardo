import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/api/error-response";
import { getInfrastructureSnapshot } from "@/lib/attention/infrastructure";
import { hasSelfDeploy, infrastructureRows } from "@/lib/attention/infrastructure-rows";
import { getSession } from "@/lib/auth/session";

/**
 * GET — state of Vardo's own stack and the shared core services.
 * Platform-level and tenant-free, so any authenticated session may read it.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const snapshot = await getInfrastructureSnapshot();
    const rows = infrastructureRows(snapshot, {
      canLinkToAdmin: !!session.user?.isAppAdmin,
    });

    return NextResponse.json({ rows, selfDeploy: hasSelfDeploy(rows) });
  } catch (error) {
    return handleRouteError(error, "Error reading infrastructure status");
  }
}
