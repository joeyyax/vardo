import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, domains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// PUT — set primary domain
async function handlePut(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.domains");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });
    if (!app) {
      return apiError.notFound("app");
    }

    const { domainId } = await request.json();

    await db
      .update(domains)
      .set({ isPrimary: false })
      .where(eq(domains.appId, appId));

    await db
      .update(domains)
      .set({ isPrimary: true })
      .where(and(eq(domains.id, domainId), eq(domains.appId, appId)));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "domains-primary" });
