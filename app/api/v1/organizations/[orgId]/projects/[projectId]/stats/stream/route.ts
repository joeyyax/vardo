import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { createSSEResponse } from "@/lib/api/sse";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { isFeatureEnabled } from "@/lib/config/features";
import { subscribe } from "@/lib/metrics/broadcast";
import { aggregateContainers } from "@/lib/metrics/aggregate";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats/stream
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("metrics")) {
      return new Response(JSON.stringify({ error: "Feature not enabled" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!isMetricsEnabled()) {
      return new Response(null, { status: 204 });
    }

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) {
      return new Response("Not found", { status: 404 });
    }

    const projectApps = await db.query.apps.findMany({
      where: and(eq(apps.projectId, projectId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, displayName: true, status: true },
    });

    return createSSEResponse(request, async (sendEvent) => {
      const unsubscribe = subscribe((allMetrics) => {
        // Collect all containers belonging to this project's apps
        const projectContainers = allMetrics.filter((m) =>
          projectApps.some(
            (app) => m.projectName === app.name || m.projectName.startsWith(`${app.name}-`)
          )
        );

        const point = aggregateContainers(projectContainers);
        sendEvent("point", point);
      });

      request.signal.addEventListener("abort", unsubscribe);

      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve());
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error streaming project stats");
  }
}
