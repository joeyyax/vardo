import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { domains, domainChecks, apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc, inArray } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET — return recent domain check results for an app's domains
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Get all domains for this app
    const appDomains = await db.query.domains.findMany({
      where: eq(domains.appId, appId),
      columns: { id: true, domain: true },
    });

    if (appDomains.length === 0) {
      return NextResponse.json({ checks: [] });
    }

    const domainIds = appDomains.map((d) => d.id);

    // Get recent checks for each domain (last 10 per domain)
    const checks = await db.query.domainChecks.findMany({
      where: inArray(domainChecks.domainId, domainIds),
      orderBy: [desc(domainChecks.checkedAt)],
      limit: appDomains.length * 10,
      with: {
        domain: {
          columns: { domain: true },
        },
      },
    });

    return NextResponse.json({ checks });
  } catch (error) {
    return handleRouteError(error, "Error fetching domain health");
  }
}
