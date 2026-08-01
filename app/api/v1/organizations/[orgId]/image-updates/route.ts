import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getAggregateUpdateStatus } from "@/lib/docker/image-updates/status";
import { getCooldownUntil, refreshStaleChecks } from "@/lib/docker/image-updates/check";

type RouteParams = { params: Promise<{ orgId: string }> };

// GET — org-wide roll-up, read straight from the cache.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Parents own the compose; including children would double-count.
    const rows = await db
      .select({
        id: apps.id,
        name: apps.name,
        displayName: apps.displayName,
        deployType: apps.deployType,
        imageName: apps.imageName,
        composeContent: apps.composeContent,
        composeService: apps.composeService,
      })
      .from(apps)
      .where(and(eq(apps.organizationId, orgId), isNull(apps.parentAppId)));

    const cooldownUntil = await getCooldownUntil();
    return NextResponse.json(await getAggregateUpdateStatus(rows, cooldownUntil));
  } catch (error) {
    return handleRouteError(error, "Error reading image updates");
  }
}

// POST — asks for a sweep now. Still bounded by the batch cap and cooldown.
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const cooldownUntil = await getCooldownUntil();
    if (Date.now() < cooldownUntil) {
      return NextResponse.json(
        {
          error: "A registry rate limit is still cooling down",
          cooldownUntil: new Date(cooldownUntil).toISOString(),
        },
        { status: 429 },
      );
    }

    const checked = await refreshStaleChecks();
    return NextResponse.json({ checked });
  } catch (error) {
    return handleRouteError(error, "Error refreshing image updates");
  }
}

export const GET = handleGet;
export const POST = withRateLimit(handlePost, { tier: "mutation", key: "image-updates-refresh" });
