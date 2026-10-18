import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { readDeployTrack } from "@/lib/pipeline/read";

type RouteParams = { params: Promise<{ orgId: string; appId: string; deploymentId: string }> };

// GET /api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]/track
// A deploy's stage segments, likely builder, last good run and the app's stage medians.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, deploymentId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();
    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });
    if (!app) return apiError.notFound("app");
    const track = await readDeployTrack(appId, deploymentId);
    if (!track) return apiError.notFound("deployment");
    const res = NextResponse.json(track);
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (error) {
    return handleRouteError(error, "Error reading the deploy");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/apps/deployments/track" });
