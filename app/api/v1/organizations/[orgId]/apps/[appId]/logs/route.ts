import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { listContainers } from "@/lib/docker/client";
import { readLogHistory } from "@/lib/logging/history";
import { resolveLogScope } from "@/lib/logging/scope";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/logs
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true, name: true, parentAppId: true, composeService: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const searchParams = request.nextUrl.searchParams;
    const tail = parseInt(searchParams.get("tail") || "200");
    const search = searchParams.get("search") || undefined;
    const environment = searchParams.get("environment") || "production";
    const allServices = searchParams.get("services") === "all";

    const scope = await resolveLogScope(app, { allServices });
    const history = await readLogHistory({
      project: scope.project,
      environment,
      service: scope.service,
      prefixed: scope.prefixed,
      search,
      tail,
    });

    const containers = await listContainers(scope.project).catch(() => []);

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
