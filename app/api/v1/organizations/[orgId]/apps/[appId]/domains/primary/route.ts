import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { setPrimaryDomain } from "@/lib/domains/manage";
import { domainResponse } from "@/lib/domains/domain-response";

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
      where: eq(apps.id, appId),
      columns: { id: true, organizationId: true, isSystemManaged: true },
    });
    if (!app || app.organizationId !== orgId) return apiError.notFound("app");

    const { domainId } = await request.json();
    const result = await setPrimaryDomain(app, domainId);
    if (!result.ok) return domainResponse(result);

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "domains-primary" });
