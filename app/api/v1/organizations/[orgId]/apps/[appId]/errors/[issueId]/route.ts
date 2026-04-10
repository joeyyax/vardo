import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isFeatureEnabledAsync } from "@/lib/config/features";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; issueId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/errors/[issueId]
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { orgId, issueId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const enabled = await isFeatureEnabledAsync("error-tracking");
    if (!enabled) {
      return NextResponse.json({ error: "Error tracking is disabled" }, { status: 404 });
    }

    const { getIssueLatestEvent } = await import("@/lib/error-tracking/client");
    const event = await getIssueLatestEvent(parseInt(issueId, 10));

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return NextResponse.json({ event });
  } catch (error) {
    return handleRouteError(error, "Error fetching error detail");
  }
}
