import { NextRequest, NextResponse } from "next/server";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
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
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;

    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });
    if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
