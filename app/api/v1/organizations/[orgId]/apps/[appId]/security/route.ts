import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appSecurityScans } from "@/lib/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { apiError } from "@/lib/api/error-response";
import { isAppAdmin } from "@/lib/auth/admin";
import { bindRoots, getBindWarnings } from "@/lib/docker/bind-roots";
import { isUnder } from "@/lib/docker/compose-root";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

/**
 * GET /api/v1/organizations/[orgId]/apps/[appId]/security
 * The app's 10 most recent security scans and its bind mounts outside the allowed host roots.
 */
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;

    const app = await verifyAppAccess(orgId, appId, "app.view");
    if (!app) return apiError.forbidden();

    const scans = await db.query.appSecurityScans.findMany({
      where: and(
        eq(appSecurityScans.appId, appId),
        eq(appSecurityScans.organizationId, orgId),
      ),
      orderBy: [desc(appSecurityScans.startedAt)],
      limit: 10,
    });

    const [warnings, roots, canAllow] = await Promise.all([getBindWarnings(appId), bindRoots(), isAppAdmin()]);
    const outside = warnings.filter((p) => !roots.some((r) => isUnder(p, r)));

    return NextResponse.json({ scans, bindMounts: { outsideRoots: outside, canAllow } });
  } catch (err) {
    console.error("[security] GET error:", err);
    return apiError.internal();
  }
}

export const GET = withRateLimit(handleGet, { tier: "poll", key: "get:v1/organizations/*/apps/*/security" });
