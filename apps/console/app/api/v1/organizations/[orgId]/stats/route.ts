import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";
import { queryMetrics, queryMetricsPoints } from "@/lib/metrics/store";
import type { MetricsPoint } from "@/lib/metrics/types";
type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/stats
// Returns current stats for all projects in the org, or historical data with ?from=&to=
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const orgApps = await db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      columns: { id: true, name: true, displayName: true, status: true },
    });

    const searchParams = request.nextUrl.searchParams;
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const bucket = searchParams.get("bucket");

    // Historical query
    if (from && to) {
      const fromMs = parseInt(from);
      const toMs = parseInt(to);
      const bucketMs = parseInt(bucket || "30000");
      const perProject = searchParams.get("perProject") === "true";

      const activeApps = orgApps.filter((p) => p.status === "active");
      const activeAppNames = activeApps.map((p) => p.name);

      if (perProject) {
        const metricFilter = searchParams.get("metric");
        const result: Record<string, Record<string, [number, number][]>> = {};

        await Promise.allSettled(
          activeApps.map(async (p) => {
            if (metricFilter === "cpu") {
              // Fast path: only fetch CPU for sparklines
              const cpu = await queryMetrics(p.name, "cpu", fromMs, toMs, { type: "avg", bucketMs });
              result[p.id] = { cpu };
            } else {
              const [cpu, memory, networkRx, networkTx, disk] = await Promise.all([
                queryMetrics(p.name, "cpu", fromMs, toMs, { type: "avg", bucketMs }),
                queryMetrics(p.name, "memory", fromMs, toMs, { type: "avg", bucketMs }),
                queryMetrics(p.name, "networkRx", fromMs, toMs, { type: "sum", bucketMs }),
                queryMetrics(p.name, "networkTx", fromMs, toMs, { type: "sum", bucketMs }),
                queryMetrics(p.name, "disk", fromMs, toMs, { type: "avg", bucketMs }),
              ]);
              result[p.id] = { cpu, memory, networkRx, networkTx, disk };
            }
          })
        );

        return NextResponse.json({ apps: result });
      }

      // Aggregate across all projects
      const perAppPoints = await Promise.all(
        activeAppNames.map((name) => queryMetricsPoints(name, fromMs, toMs, bucketMs))
      );
      // Merge all apps' points by timestamp
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
            existing.diskTotal += p.diskTotal;
          } else {
            pointMap.set(p.timestamp, { ...p });
          }
        }
      }

      const points = Array.from(pointMap.values()).sort((a, b) => a.timestamp - b.timestamp);
      return NextResponse.json({ points });
    }

    // Live snapshot
    try {
      const allMetrics = await fetchAllContainerMetrics();
      const appNames = new Set(orgApps.map((p) => p.name));

      // Group by project
      const byApp: Record<string, typeof allMetrics> = {};
      for (const m of allMetrics) {
        // Match project name (handles blue/green slots like "redis-blue")
        const matchedApp = orgApps.find(
          (p) => m.projectName === p.name || m.projectName.startsWith(`${p.name}-`)
        );
        if (!matchedApp) continue;
        if (!byApp[matchedApp.id]) byApp[matchedApp.id] = [];
        byApp[matchedApp.id].push(m);
      }

      return NextResponse.json({
        projects: orgApps.map((p) => ({
          ...p,
          containers: byApp[p.id] || [],
        })),
        timestamp: new Date().toISOString(),
      });
    } catch {
      // cAdvisor not available — return projects without stats
      return NextResponse.json({
        projects: orgApps.map((p) => ({ ...p, containers: [] })),
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    return handleRouteError(error, "Error fetching org stats");
  }
}
