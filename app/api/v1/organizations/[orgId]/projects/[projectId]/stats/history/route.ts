import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { queryMetricsPoints } from "@/lib/metrics/store";
import type { MetricsPoint } from "@/lib/metrics/types";
import { isMetricsEnabled } from "@/lib/metrics/config";
import { verifyOrgAccess } from "@/lib/api/verify-access";
type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats/history
// Aggregates historical metrics across all apps in the project
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    if (!isMetricsEnabled()) {
      return NextResponse.json({ series: {} });
    }

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) {
      return apiError.notFound("project");
    }

    // Stack children read under their parent's series, so summing both counts them twice.
    const projectApps = await db.query.apps.findMany({
      where: and(
        eq(apps.projectId, projectId),
        eq(apps.organizationId, orgId),
        isNull(apps.parentAppId),
      ),
      columns: { id: true, name: true, gpuEnabled: true },
    });

    const searchParams = request.nextUrl.searchParams;
    const from = parseInt(searchParams.get("from") || String(Date.now() - 3600_000));
    const to = parseInt(searchParams.get("to") || String(Date.now()));
    const bucket = parseInt(searchParams.get("bucket") || "30000");

    const perAppPoints = await Promise.all(
      projectApps.map((app) => queryMetricsPoints(app.name, from, to, bucket, app.gpuEnabled))
    );

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

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/projects/*/stats/history" });
