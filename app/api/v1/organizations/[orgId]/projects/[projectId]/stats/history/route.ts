import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { queryMetricsPoints } from "@/lib/metrics/store";
import type { MetricsPoint } from "@/lib/metrics/types";
import { isMetricsEnabled } from "@/lib/metrics/config";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats/history
// Aggregates historical metrics across all apps in the project
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!isMetricsEnabled()) {
      return NextResponse.json({ series: {} });
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
      columns: { id: true, name: true },
    });

    const searchParams = request.nextUrl.searchParams;
    const from = parseInt(searchParams.get("from") || String(Date.now() - 3600_000));
    const to = parseInt(searchParams.get("to") || String(Date.now()));
    const bucket = parseInt(searchParams.get("bucket") || "30000");

    // Query all apps in parallel, then merge points
    const perAppPoints = await Promise.all(
      projectApps.map((app) => queryMetricsPoints(app.name, from, to, bucket))
    );

    // Merge by summing at each timestamp
    const pointMap = new Map<number, MetricsPoint>();
    for (const appPoints of perAppPoints) {
      for (const p of appPoints) {
        const existing = pointMap.get(p.timestamp);
        if (existing) {
          existing.cpu += p.cpu;
          existing.memory += p.memory;
          existing.memoryLimit = Math.max(existing.memoryLimit, p.memoryLimit);
          existing.networkRx += p.networkRx;
          existing.networkTx += p.networkTx;
        } else {
          pointMap.set(p.timestamp, { ...p });
        }
      }
    }

    const points = Array.from(pointMap.values()).sort((a, b) => a.timestamp - b.timestamp);

    return NextResponse.json({ points });
  } catch (error) {
    return handleRouteError(error, "Error fetching project metrics history");
  }
}
