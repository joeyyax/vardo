import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { restartReading } from "@/lib/db/app-restarts";
import { apps } from "@/lib/db/schema";

/**
 * The restart counter as the status reconciler last read it, with the point it
 * counts from. The same stored figure the list rows carry — an inspect here
 * would give the same app two answers, and null is not zero in either.
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
      columns: { containerRestartCount: true, containerRestartSince: true },
    });
    if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const res = NextResponse.json({ restarts: restartReading(app) });
    res.headers.set("Cache-Control", "private, max-age=15");
    return res;
  } catch (error) {
    return handleRouteError(error, "Error reading container restarts");
  }
}

export const GET = withRateLimit(handler, { tier: "read", key: "app-stability" });
