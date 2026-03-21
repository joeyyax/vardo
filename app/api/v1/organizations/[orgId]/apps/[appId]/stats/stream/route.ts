import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { createSSEResponse } from "@/lib/api/sse";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { subscribe } from "@/lib/metrics/broadcast";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/stats/stream
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!isMetricsEnabled()) {
      return new Response(null, { status: 204 });
    }

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true, name: true },
    });

    if (!app) {
      return new Response("Not found", { status: 404 });
    }

    const environment = request.nextUrl.searchParams.get("environment") || undefined;

    return createSSEResponse(request, async (sendEvent) => {
      const unsubscribe = subscribe((allMetrics) => {
        // Filter to this app's containers
        let containers = allMetrics.filter(
          (m) => m.projectName === app.name || m.projectName.startsWith(`${app.name}-`)
        );

        if (environment) {
          const envPrefix = `${app.name}-${environment}-`;
          containers = containers.filter(
            (m) => m.containerName.startsWith(envPrefix) || m.projectName.startsWith(envPrefix)
          );
        }

        sendEvent("stats", {
          containers: containers.map((m) => ({
            containerId: m.containerId,
            containerName: m.containerName,
            cpuPercent: m.cpuPercent,
            memoryUsage: m.memoryUsage,
            memoryLimit: m.memoryLimit,
            memoryPercent: m.memoryPercent,
            networkRx: m.networkRxBytes,
            networkTx: m.networkTxBytes,
            diskUsage: m.diskUsage,
            diskLimit: m.diskLimit,
          })),
          timestamp: new Date().toISOString(),
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
