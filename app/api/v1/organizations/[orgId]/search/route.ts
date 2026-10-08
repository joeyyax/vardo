import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects, orgEnvVars } from "@/lib/db/schema";
import { eq, asc, desc } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/search
// Searchable entity index for the command palette, cached 30s.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

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
          parentAppId: true,
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

    // Compose children share names across stacks, so each carries its parent.
    const byId = new Map(orgApps.map((app) => [app.id, app]));

    const response = NextResponse.json({
      apps: orgApps.map((app) => ({
        id: app.id,
        name: app.name,
        displayName: app.displayName,
        status: app.status,
        source: app.source,
        deployType: app.deployType,
        imageName: app.imageName,
        parentName: app.parentAppId ? byId.get(app.parentAppId)?.displayName ?? null : null,
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

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/search" });
