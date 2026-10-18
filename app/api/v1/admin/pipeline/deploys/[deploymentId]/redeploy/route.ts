import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { enqueueDeploy } from "@/lib/deploy/queue";
import { refuseSystemManaged } from "@/lib/api/system-managed";

type RouteParams = { params: Promise<{ deploymentId: string }> };

// POST /api/v1/admin/pipeline/deploys/[deploymentId]/redeploy
// Queues a fresh deploy of the same app and environment.
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await requireAppAdmin();
    const { deploymentId } = await params;
    const [row] = await db
      .select({ appId: deployments.appId, environmentId: deployments.environmentId, isSystemManaged: apps.isSystemManaged })
      .from(deployments)
      .innerJoin(apps, eq(apps.id, deployments.appId))
      .where(eq(deployments.id, deploymentId));
    if (!row) return apiError.notFound("deployment");
    const refused = refuseSystemManaged({ isSystemManaged: row.isSystemManaged }, "deploy");
    if (refused) return refused;
    const { id } = await enqueueDeploy({
      appId: row.appId,
      trigger: "manual",
      triggeredBy: session.user.id,
      environmentId: row.environmentId ?? undefined,
    });
    return NextResponse.json({ id });
  } catch (error) {
    return handleRouteError(error, "Error redeploying");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "deploy" });
