import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { recreateProject } from "@/lib/docker/deploy";
import { resolveDefaultEnv } from "@/lib/docker/resolve-env";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemManaged } from "@/lib/api/system-managed";
import { reconcileAppNow } from "@/lib/docker/status-reconcile";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.deploy");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, isSystemManaged: true },
    });

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "recreate");
    if (refused) return refused;

    // Needs the environment name; without it this finds nothing.
    const env = await resolveDefaultEnv(appId);
    const result = await recreateProject(appId, app.name, env.name);
    // Force-recreate replaces every container, so the row's start time is stale.
    if (result.success) await reconcileAppNow(appId);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error recreating app");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-recreate" });
