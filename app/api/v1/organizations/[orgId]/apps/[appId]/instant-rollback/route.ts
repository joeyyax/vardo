import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveDefaultEnv } from "@/lib/docker/resolve-env";
import { performInstantRollback } from "@/lib/docker/instant-rollback";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";

async function handler(request: NextRequest, { params }: { params: Promise<{ orgId: string; appId: string }> }) {
  const { orgId, appId } = await params;

  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, isSystemManaged: true },
    });

    if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (app.isSystemManaged) {
      return NextResponse.json({ error: "System-managed apps cannot be rolled back" }, { status: 403 });
    }

    const env = await resolveDefaultEnv(appId);

    if (env.type === "local") {
      return NextResponse.json({ error: "Instant rollback is not available for local environments" }, { status: 400 });
    }

    const result = await performInstantRollback({
      appId,
      appName: app.name,
      organizationId: orgId,
      userId: org.session.user.id,
      env,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error performing instant rollback");
  }
}

export const POST = withRateLimit(handler, { tier: "critical", key: "instant-rollback" });
