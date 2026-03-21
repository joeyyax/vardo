import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { fetchProjectMetrics } from "@/lib/metrics/cadvisor";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, orgId)
      ),
      columns: { id: true, name: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const environment = _request.nextUrl.searchParams.get("environment") || undefined;
    const metrics = await fetchProjectMetrics(project.name, environment);

    return NextResponse.json({
      containers: metrics.map((m) => ({
        containerId: m.containerId,
        containerName: m.containerName,
        cpuPercent: m.cpuPercent,
        memoryUsage: m.memoryUsage,
        memoryLimit: m.memoryLimit,
        memoryPercent: m.memoryPercent,
        networkRx: m.networkRxBytes,
        networkTx: m.networkTxBytes,
        blockRead: 0,
        blockWrite: 0,
        diskUsage: m.diskUsage,
        diskLimit: m.diskLimit,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching container stats");
  }
}
