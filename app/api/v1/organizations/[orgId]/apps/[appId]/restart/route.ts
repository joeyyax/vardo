import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { restartContainers } from "@/lib/docker/deploy";
import { resolveDefaultEnv } from "@/lib/docker/resolve-env";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemManaged } from "@/lib/api/system-managed";
import { recordLifecycle } from "@/lib/activity/lifecycle";
import { reconcileAppNow } from "@/lib/docker/status-reconcile";

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

    // A compose child has no deployed directory of its own — the parent owns
    // the project, and the child is one service inside it.
    let ownerId = app.id;
    let project = app.name;
    if (app.parentAppId) {
      const parent = await db.query.apps.findFirst({
        where: and(eq(apps.id, app.parentAppId), eq(apps.organizationId, orgId)),
        columns: { id: true, name: true },
      });
      if (!parent) {
        return NextResponse.json({ error: "Parent app not found" }, { status: 404 });
      }
      ownerId = parent.id;
      project = parent.name;
    }

    const env = await resolveDefaultEnv(ownerId);
    const result = await restartContainers(
      project,
      env.name,
      app.parentAppId ? app.composeService ?? undefined : undefined,
    );

    // The UI's Start button posts here too — compose brings stopped services
    // back up. What the app was doing beforehand is the only thing that tells
    // the two apart.
    if (result.success) {
      const wasOff = app.status === "stopped" || app.status === "missing";
      // The containers are new; the row still describes the ones they replaced.
      const observed = await reconcileAppNow(app.id);
      // `compose restart` exits clean against a project whose containers were
      // removed, so a start that brought nothing up must not claim one.
      const cameUp = observed === null || observed === "active";
      if (!wasOff || cameUp) {
        await recordLifecycle({
          organizationId: orgId,
          app,
          kind: wasOff ? "started" : "restarted",
          userId: org.session.user.id,
          trigger: org.session.authMethod === "token" ? "api" : undefined,
        });
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error restarting app");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-restart" });
