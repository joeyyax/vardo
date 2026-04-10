import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isFeatureEnabledAsync } from "@/lib/config/features";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/errors
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const enabled = await isFeatureEnabledAsync("error-tracking");
    if (!enabled) {
      return NextResponse.json({ error: "Error tracking is disabled" }, { status: 404 });
    }

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { listIssues, isGlitchTipAvailable } = await import("@/lib/error-tracking/client");

    const available = await isGlitchTipAvailable();
    if (!available) {
      return NextResponse.json({ issues: [], available: false });
    }

    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "25", 10);
    const issues = await listIssues(app.name, { limit });

    return NextResponse.json({ issues, available: true });
  } catch (error) {
    return handleRouteError(error, "Error fetching error tracking data");
  }
}
