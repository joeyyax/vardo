import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createSSEResponse } from "@/lib/api/sse";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { subscribe } from "@/lib/metrics/broadcast";
import { aggregateContainers, containerToPoint } from "@/lib/metrics/aggregate";
import { matchAppMetrics, filterByEnvironment } from "@/lib/metrics/app-match";
import { METRICS_APP_COLUMNS } from "@/lib/metrics/app-columns";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/stats/stream
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return new Response("Forbidden", { status: 403 });

    if (!isMetricsEnabled()) {
      return new Response(null, { status: 204 });
    }

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: METRICS_APP_COLUMNS,
    });

    if (!app) {
      return new Response("Not found", { status: 404 });
    }

    const environment = request.nextUrl.searchParams.get("environment") || undefined;

    return createSSEResponse(request, async (sendEvent) => {
      const unsubscribe = subscribe((allMetrics) => {
        const matched = matchAppMetrics(app, allMetrics);
        const containers = environment ? filterByEnvironment(matched, environment) : matched;

        const point = aggregateContainers(containers);
        sendEvent("point", {
          ...point,
          containers: containers.map(containerToPoint),
        });
      });

      request.signal.addEventListener("abort", unsubscribe);

      // Keep alive until disconnect
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve());
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error streaming stats");
  }
}
