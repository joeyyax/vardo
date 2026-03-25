import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { fetchProjectMetrics } from "@/lib/metrics/cadvisor";
import { verifyOrgAccess } from "@/lib/api/verify-access";
type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/stats
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true, name: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const environment = _request.nextUrl.searchParams.get("environment") || undefined;
    const metrics = await fetchProjectMetrics(app.name, environment);

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
