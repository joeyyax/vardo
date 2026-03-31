import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appSecurityScans } from "@/lib/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { verifyAppAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

/**
 * GET /api/v1/organizations/[orgId]/apps/[appId]/security
 *
 * Returns the most recent security scans for an app (up to 10).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;

    const app = await verifyAppAccess(orgId, appId);
    if (!app) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const scans = await db.query.appSecurityScans.findMany({
      where: and(
        eq(appSecurityScans.appId, appId),
        eq(appSecurityScans.organizationId, orgId),
      ),
      orderBy: [desc(appSecurityScans.startedAt)],
      limit: 10,
    });

    return NextResponse.json({ scans });
  } catch (err) {
    console.error("[security] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
