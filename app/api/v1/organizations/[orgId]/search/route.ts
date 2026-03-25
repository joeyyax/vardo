import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects, orgEnvVars } from "@/lib/db/schema";
import { eq, asc, desc } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/search
// Returns a lightweight index of all searchable entities for the command palette.
// Cached for 30s to avoid re-querying on every Cmd+K open.
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const [orgApps, orgProjects, sharedEnvVars] = await Promise.all([
      db.query.apps.findMany({
        where: eq(apps.organizationId, orgId),
        orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
        columns: {
          id: true,
          name: true,
          displayName: true,
          status: true,
          source: true,
          deployType: true,
          imageName: true,
        },
        with: {
          project: { columns: { name: true, displayName: true } },
          domains: { columns: { domain: true } },
        },
      }),
      db.query.projects.findMany({
        where: eq(projects.organizationId, orgId),
        columns: { id: true, name: true, displayName: true },
      }),
      db.query.orgEnvVars.findMany({
        where: eq(orgEnvVars.organizationId, orgId),
        columns: { key: true },
      }),
    ]);

    const response = NextResponse.json({
      apps: orgApps.map((app) => ({
        id: app.id,
        name: app.name,
        displayName: app.displayName,
        status: app.status,
        source: app.source,
        deployType: app.deployType,
        imageName: app.imageName,
        projectName: app.project?.displayName || null,
        domains: app.domains?.map((d) => d.domain) || [],
      })),
      projects: orgProjects,
      orgEnvKeys: sharedEnvVars.map((e) => e.key),
    });

    response.headers.set("Cache-Control", "private, max-age=30");
    return response;
  } catch (error) {
    return handleRouteError(error, "Error fetching search index");
  }
}
