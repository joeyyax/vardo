import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { stopProject } from "@/lib/docker/deploy";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemManaged } from "@/lib/api/system-managed";
import { recordLifecycle } from "@/lib/activity/lifecycle";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: {
        id: true,
        name: true,
        isSystemManaged: true,
        parentAppId: true,
        composeService: true,
      },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const refused = refuseSystemManaged(app, "stop");
    if (refused) return refused;

    const startedAt = Date.now();
    const result = await stopProject(appId, app.name);

    if (result.success) {
      await recordLifecycle({
        organizationId: orgId,
        app,
        kind: "stopped",
        userId: org.session.user.id,
        trigger: org.session.authMethod === "token" ? "api" : undefined,
        durationMs: Date.now() - startedAt,
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error stopping app");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-stop" });
