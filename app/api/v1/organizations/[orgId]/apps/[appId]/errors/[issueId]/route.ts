import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isFeatureEnabledAsync } from "@/lib/config/features";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; issueId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/errors/[issueId]
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { orgId, appId, issueId } = await params;
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

    const { getIssueProjectSlug, getIssueLatestEvent } = await import("@/lib/error-tracking/client");

    // GlitchTip issue ids are global and sequential — the issue must sit in
    // this app's project, which is registered under the app name.
    const projectSlug = await getIssueProjectSlug(parseInt(issueId, 10));
    if (projectSlug !== app.name) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const event = await getIssueLatestEvent(parseInt(issueId, 10));

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return NextResponse.json({ event });
  } catch (error) {
    return handleRouteError(error, "Error fetching error detail");
  }
}
