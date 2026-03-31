import { NextRequest, NextResponse } from "next/server";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { runSecurityScan } from "@/lib/security/scanner";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

/**
 * POST /api/v1/organizations/[orgId]/apps/[appId]/security/scan
 *
 * Trigger an on-demand security scan for an app. Runs the scan inline
 * and returns the scan ID when complete.
 */
async function handler(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;

    const app = await verifyAppAccess(orgId, appId);
    if (!app) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const scanId = await runSecurityScan({
      appId,
      organizationId: orgId,
      trigger: "manual",
    });

    if (!scanId) {
      return NextResponse.json({ error: "Scan failed to start" }, { status: 500 });
    }

    return NextResponse.json({ scanId });
  } catch (err) {
    console.error("[security] scan error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withRateLimit(handler, { tier: "mutation" });
