import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { resolveDefaultEnv } from "@/lib/docker/resolve-env";
import { checkStandbyAvailable } from "@/lib/docker/instant-rollback";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";

async function handler(_request: NextRequest, { params }: { params: Promise<{ orgId: string; appId: string }> }) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true },
    });

    if (!app) return apiError.notFound("app");

    const env = await resolveDefaultEnv(appId);
    const status = await checkStandbyAvailable(app.name, env);

    let standbyDeployment = null;
    if (status.standbySlot && status.standbyAvailable) {
      standbyDeployment = await db.query.deployments.findFirst({
        where: and(
          eq(deployments.appId, appId),
          eq(deployments.status, "success"),
          eq(deployments.slot, status.standbySlot),
        ),
        orderBy: [desc(deployments.startedAt)],
        columns: {
          id: true,
          gitSha: true,
          gitMessage: true,
          startedAt: true,
          finishedAt: true,
        },
      });
    }

    const res = NextResponse.json({
      ...status,
      standbyDeploymentId: standbyDeployment?.id ?? null,
      standbyDeployment,
    });
    res.headers.set("Cache-Control", "private, max-age=5");
    return res;
  } catch (error) {
    return handleRouteError(error, "Error fetching slot status");
  }
}

export const GET = withRateLimit(handler, { tier: "read", key: "slot-status" });
