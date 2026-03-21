import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { isFeatureEnabled } from "@/lib/config/features";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("metrics")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
    }

    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
      columns: { id: true, name: true, displayName: true, status: true },
    });

    const allMetrics = await fetchAllContainerMetrics();
    const appNames = new Set(projectApps.map((a) => a.name));

    const appStats = projectApps.map((app) => {
      const containers = allMetrics
        .filter((m) => m.projectName === app.name || m.projectName.startsWith(`${app.name}-`))
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
