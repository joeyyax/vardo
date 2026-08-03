import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { fetchAllMetrics } from "@/lib/metrics/provider";
import { groupMetricsByApp } from "@/lib/metrics/app-match";
import { METRICS_APP_COLUMNS } from "@/lib/metrics/app-columns";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { verifyOrgAccess } from "@/lib/api/verify-access";
type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if (!isMetricsEnabled()) {
      return NextResponse.json({ apps: [], timestamp: new Date().toISOString() });
    }

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const projectApps = await db.query.apps.findMany({
      where: and(eq(apps.projectId, projectId), eq(apps.organizationId, orgId)),
      columns: { ...METRICS_APP_COLUMNS, displayName: true },
    });

    const byApp = groupMetricsByApp(projectApps, await fetchAllMetrics());

    const appStats = projectApps.map((app) => {
      const containers = (byApp.get(app.id) ?? [])
        .map((m) => ({
          containerId: m.containerId,
          containerName: m.containerName,
          cpuPercent: m.cpuPercent,
          memoryUsage: m.memoryUsage,
          memoryLimit: m.memoryLimit,
          memoryPercent: m.memoryPercent,
          networkRx: m.networkRxBytes,
          networkTx: m.networkTxBytes,
        }));
      return { ...app, containers };
    });

    return NextResponse.json({
      apps: appStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching project stats");
  }
}
