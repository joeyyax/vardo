import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { recordActivity } from "@/lib/activity/record";
import { allowOnBattery, recordDeployOverride } from "@/lib/power/deploys";
import { readPowerGate } from "@/lib/power/gate";
import { markQueueWaits } from "@/lib/deploy/waiting";
import { logger } from "@/lib/logger";

const log = logger.child("power");

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; deploymentId: string }>;
};

// POST /api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]/deploy-anyway
// Instance admins only: lets a deploy held for power run on battery.
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, deploymentId } = await params;

    const org = await verifyOrgAccess(orgId, "app.deploy");
    if (!org || !(await isAppAdmin())) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, displayName: true },
    });
    if (!app) return apiError.notFound("app");

    const deployment = await db.query.deployments.findFirst({
      where: and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)),
      columns: { id: true },
    });
    if (!deployment) return apiError.notFound("deployment");

    if (!(await allowOnBattery(deploymentId))) {
      return NextResponse.json({ error: "Only a queued deploy can be started on battery" }, { status: 409 });
    }
    await markQueueWaits().catch((err) => log.warn("Couldn't recompute queue waits after an override:", err));

    const by = org.session.user.name?.trim() || org.session.user.email;
    const gate = await readPowerGate();
    await recordDeployOverride(app.displayName, by, gate.outage);
    await recordActivity({
      organizationId: orgId,
      action: "deployment.power-override",
      appId,
      userId: org.session.user.id,
      metadata: { deploymentId },
    }).catch((err) => log.warn("Couldn't record the override:", err));

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error starting the deploy on battery");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-deployments-deploy-anyway" });
