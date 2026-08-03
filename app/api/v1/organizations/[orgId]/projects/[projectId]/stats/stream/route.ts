import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createSSEResponse } from "@/lib/api/sse";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { subscribe } from "@/lib/metrics/broadcast";
import { aggregateContainers } from "@/lib/metrics/aggregate";
import { groupMetricsByApp, dedupeMetrics } from "@/lib/metrics/app-match";
import { METRICS_APP_COLUMNS } from "@/lib/metrics/app-columns";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats/stream
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return new Response("Forbidden", { status: 403 });

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
      columns: { ...METRICS_APP_COLUMNS, displayName: true },
    });

    return createSSEResponse(request, async (sendEvent) => {
      const unsubscribe = subscribe((allMetrics) => {
        const projectContainers = dedupeMetrics(
          groupMetricsByApp(projectApps, allMetrics).values(),
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
