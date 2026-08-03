import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { listAllContainers, inspectContainer } from "@/lib/docker/client";
import { matchContainers, type ReconcilableApp } from "@/lib/docker/container-match";
import type { RestartReading } from "@/lib/ui/stability";

/**
 * The one stability figure that has to come from Docker rather than the
 * database. The timeline is durable and rendered from the page's own query;
 * this counter lives on the container and dies with it.
 */
async function handler(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string; appId: string }> },
) {
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
        parentAppId: true,
        composeService: true,
        containerName: true,
        importedContainerId: true,
      },
    });
    if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const res = NextResponse.json({ restarts: await readRestarts(app) });
    res.headers.set("Cache-Control", "private, max-age=15");
    return res;
  } catch (error) {
    return handleRouteError(error, "Error reading container restarts");
  }
}

/**
 * Docker's restart counter across the app's containers, with the oldest of
 * their creation times — the point the count last reset to zero. Null when
 * Docker cannot be read, so the caller shows nothing rather than a false zero.
 */
async function readRestarts(app: ReconcilableApp): Promise<RestartReading | null> {
  try {
    const matched = matchContainers(app, await listAllContainers());
    if (matched.length === 0) return { count: 0, since: null };

    let count = 0;
    let oldest: number | null = null;
    for (const c of matched) {
      const info = await inspectContainer(c.id);
      count += info.restartCount;
      const created = Date.parse(info.createdAt);
      if (!isNaN(created) && (oldest === null || created < oldest)) oldest = created;
    }
    return { count, since: oldest === null ? null : new Date(oldest).toISOString() };
  } catch {
    return null;
  }
}

export const GET = withRateLimit(handler, { tier: "read", key: "app-stability" });
