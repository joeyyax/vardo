import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { queryMetrics } from "@/lib/metrics/store";
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

    const agg = { type: "avg" as const, bucketMs: bucket };
    const metrics = ["cpu", "memory", "networkRx", "networkTx"] as const;

    // Query all apps in parallel, then merge
    const perAppResults = await Promise.all(
      projectApps.map(async (app) => {
        const series: Record<string, [number, number][]> = {};
        await Promise.all(
          metrics.map(async (metric) => {
            series[metric] = await queryMetrics(app.name, metric, from, to,
              metric === "memory" ? { type: "avg", bucketMs: bucket } : agg
            );
          })
        );
        return series;
      })
    );

    // Aggregate across apps at each timestamp
    const merged: Record<string, [number, number][]> = {};
    for (const metric of metrics) {
      const pointMap = new Map<number, number>();
      for (const appSeries of perAppResults) {
        for (const [ts, val] of appSeries[metric] || []) {
          pointMap.set(ts, (pointMap.get(ts) || 0) + val);
        }
      }
      merged[metric] = Array.from(pointMap.entries()).sort((a, b) => a[0] - b[0]);
    }

    return NextResponse.json({
      from,
      to,
      bucketMs: bucket,
      series: merged,
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching project metrics history");
  }
}
