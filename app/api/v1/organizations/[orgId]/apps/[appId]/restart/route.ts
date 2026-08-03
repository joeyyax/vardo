import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { startOrRestartApp } from "@/lib/docker/start-app";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemManaged } from "@/lib/api/system-managed";

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
        status: true,
        isSystemManaged: true,
        parentAppId: true,
        composeService: true,
      },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const refused = refuseSystemManaged(app, "restart");
    if (refused) return refused;

    // The UI's Start button posts here too — the app's prior status is the only
    // thing that tells the two apart.
    const result = await startOrRestartApp({
      organizationId: orgId,
      app,
      userId: org.session.user.id,
      trigger: org.session.authMethod === "token" ? "api" : undefined,
    });

    if (result.failure === "no-parent") {
      return NextResponse.json({ error: "Parent app not found" }, { status: 404 });
    }

    // Callers render `error`; without it the reason never reaches the operator.
    return NextResponse.json({
      success: result.success,
      log: result.log,
      action: result.action,
      ...(result.success ? {} : { error: result.log }),
    });
  } catch (error) {
    return handleRouteError(error, "Error restarting app");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-restart" });
