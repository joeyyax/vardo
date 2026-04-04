import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { recreateProject } from "@/lib/docker/deploy";
import { verifyOrgAccess } from "@/lib/api/verify-access";

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
      columns: { id: true, name: true, isSystemManaged: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (app.isSystemManaged) {
      return NextResponse.json(
        { error: "System-managed apps cannot be recreated via the API" },
        { status: 403 }
      );
    }

    const result = await recreateProject(appId, app.name);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error recreating app");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-recreate" });
