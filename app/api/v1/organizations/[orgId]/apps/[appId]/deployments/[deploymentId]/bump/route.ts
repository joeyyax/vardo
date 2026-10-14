import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { recordActivity } from "@/lib/activity/record";
import { bumpDeploy } from "@/lib/deploy/bump";
import { logger } from "@/lib/logger";

const log = logger.child("deploy-bump");

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; deploymentId: string }>;
};

// POST /api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]/bump
// Instance admins only: moves a waiting deploy to the front of the deploy queue or the builder queue.
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, deploymentId } = await params;

    const org = await verifyOrgAccess(orgId, "app.deploy");
    if (!org || !(await isAppAdmin())) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });
    if (!app) return apiError.notFound("app");

    const deployment = await db.query.deployments.findFirst({
      where: and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)),
      columns: { id: true },
    });
    if (!deployment) return apiError.notFound("deployment");

    const queue = await bumpDeploy(deploymentId);
    if (!queue) {
      return NextResponse.json({ error: "Only a deploy waiting in the queue or for the builder can move to the front" }, { status: 409 });
    }

    await recordActivity({
      organizationId: orgId,
      action: "deployment.bumped",
      appId,
      userId: org.session.user.id,
      metadata: { deploymentId, queue },
    }).catch((err) => log.warn("Couldn't record the bump:", err));

    return NextResponse.json({ ok: true, queue });
  } catch (error) {
    return handleRouteError(error, "Error moving the deployment to the front");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-deployments-bump" });
