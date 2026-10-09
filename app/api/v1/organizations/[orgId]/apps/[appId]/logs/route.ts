import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { listContainers } from "@/lib/docker/client";
import { readLogHistory } from "@/lib/logging/history";
import { resolveLogEnvironment, resolveLogScope } from "@/lib/logging/scope";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/logs
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true, name: true, parentAppId: true, composeService: true },
    });

    if (!app) {
      return apiError.notFound("app");
    }

    const searchParams = request.nextUrl.searchParams;
    const tail = parseInt(searchParams.get("tail") || "200");
    const search = searchParams.get("search") || undefined;
    const environment = await resolveLogEnvironment(app, searchParams.get("environment"));
    if (!environment) return apiError.notFound("environment");
    const allServices = searchParams.get("services") === "all";

    const scope = await resolveLogScope(app, { allServices });
    const history = await readLogHistory({
      project: scope.project,
      organizationId: orgId,
      environment,
      service: scope.service,
      prefixed: scope.prefixed,
      search,
      tail,
    });

    const containers = await listContainers({ id: scope.projectId, name: scope.project }).catch(() => []);

    return NextResponse.json({
      source: history.source,
      logs: history.lines.map((l) => l.text).join("\n"),
      lines: history.lines,
      services: scope.services,
      containers: containers.map((c) => ({
        id: c.id,
        name: c.name,
        state: c.state,
        image: c.image,
      })),
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching logs");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/logs" });
