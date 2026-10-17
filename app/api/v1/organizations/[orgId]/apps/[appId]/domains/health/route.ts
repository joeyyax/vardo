import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { domains, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { uptimeClient } from "@/lib/uptime/client";

const CHECKS_PER_DOMAIN = 10;

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET — return recent domain check results for an app's domains
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true },
    });

    if (!app) {
      return apiError.notFound("app");
    }

    const appDomains = await db.query.domains.findMany({
      where: eq(domains.appId, appId),
      columns: { id: true, domain: true },
    });

    if (appDomains.length === 0) {
      return NextResponse.json({ checks: [] });
    }

    const hostById = new Map(appDomains.map((d) => [d.id, d.domain]));
    const rows = await uptimeClient.recentDomainChecks(orgId, [...hostById.keys()], CHECKS_PER_DOMAIN);
    const checks = rows.map((c) => ({ ...c, domain: { domain: hostById.get(c.domainId)! } }));

    return NextResponse.json({ checks });
  } catch (error) {
    return handleRouteError(error, "Error fetching domain health");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/domains/health" });
