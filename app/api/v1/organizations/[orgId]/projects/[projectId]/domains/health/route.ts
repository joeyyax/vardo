import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { domains, domainChecks, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc, inArray } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET — return recent domain check results for a project's domains
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, orgId)
      ),
      columns: { id: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Get all domains for this project
    const projectDomains = await db.query.domains.findMany({
      where: eq(domains.projectId, projectId),
      columns: { id: true, domain: true },
    });

    if (projectDomains.length === 0) {
      return NextResponse.json({ checks: [] });
    }

    const domainIds = projectDomains.map((d) => d.id);

    // Get recent checks for each domain (last 10 per domain)
    const checks = await db.query.domainChecks.findMany({
      where: inArray(domainChecks.domainId, domainIds),
      orderBy: [desc(domainChecks.checkedAt)],
      limit: projectDomains.length * 10,
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
