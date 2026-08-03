import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/api/error-response";
import { getInfrastructureSnapshot } from "@/lib/attention/infrastructure";
import { hasSelfDeploy, infrastructureRows } from "@/lib/attention/infrastructure-rows";
import { getSession } from "@/lib/auth/session";

/**
 * GET — state of Vardo's own stack and the shared core services.
 *
 * Deliberately outside /organizations: this is the platform every org runs on,
 * so it takes no org id and reads none. What it returns is a fixed set of
 * infrastructure named in the codebase, never a tenant's apps, which is why
 * any authenticated session may read it without widening org scope.
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
