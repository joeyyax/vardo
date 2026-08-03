import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { isLokiAvailable } from "@/lib/logging/client";
import { readErrorRate } from "@/lib/logging/error-rate";

/**
 * How this app's error rate compares to its own past. Read on demand rather
 * than stored — the samples behind it are what the collector writes.
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
      columns: { id: true, parentAppId: true, containerStartedAt: true },
    });
    if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (!(await isLokiAvailable())) {
      return NextResponse.json({ available: false });
    }

    const { reading, samples } = await readErrorRate(app);
    const res = NextResponse.json({ available: true, reading, samples });
    res.headers.set("Cache-Control", "private, max-age=30");
    return res;
  } catch (error) {
    return handleRouteError(error, "Error reading error rate");
  }
}

export const GET = withRateLimit(handler, { tier: "read", key: "app-error-rate" });
