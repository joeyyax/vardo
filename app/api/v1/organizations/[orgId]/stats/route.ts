import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";
import { queryMetrics, queryDiskHistory } from "@/lib/metrics/store";

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
        // Per-project sparklines for all metrics (project grid cards)
        const result: Record<string, { cpu: [number, number][]; memory: [number, number][]; networkRx: [number, number][]; networkTx: [number, number][]; disk: [number, number][] }> = {};

        await Promise.allSettled(
          activeApps.map(async (p) => {
            const [cpu, memory, networkRx, networkTx, disk] = await Promise.all([
              queryMetrics(p.name, "cpu", fromMs, toMs, { type: "avg", bucketMs }),
              queryMetrics(p.name, "memory", fromMs, toMs, { type: "avg", bucketMs }),
              queryMetrics(p.name, "networkRx", fromMs, toMs, { type: "sum", bucketMs }),
              queryMetrics(p.name, "networkTx", fromMs, toMs, { type: "sum", bucketMs }),
              queryMetrics(p.name, "disk", fromMs, toMs, { type: "avg", bucketMs }),
            ]);
            result[p.id] = { cpu, memory, networkRx, networkTx, disk };
          })
        );

        return NextResponse.json({ apps: result });
      }

      // Aggregate across all projects
      const allCpu: Map<number, number> = new Map();
      const allMem: Map<number, number> = new Map();
      const allNetRx: Map<number, number> = new Map();
      const allNetTx: Map<number, number> = new Map();

      await Promise.allSettled(
        activeAppNames.map(async (name) => {
          const [cpu, mem, netRx, netTx] = await Promise.all([
            queryMetrics(name, "cpu", fromMs, toMs, { type: "avg", bucketMs }),
            queryMetrics(name, "memory", fromMs, toMs, { type: "avg", bucketMs }),
            queryMetrics(name, "networkRx", fromMs, toMs, { type: "sum", bucketMs }),
            queryMetrics(name, "networkTx", fromMs, toMs, { type: "sum", bucketMs }),
          ]);
          for (const [ts, v] of cpu) { allCpu.set(ts, (allCpu.get(ts) || 0) + v); }
          for (const [ts, v] of mem) { allMem.set(ts, (allMem.get(ts) || 0) + v); }
          for (const [ts, v] of netRx) { allNetRx.set(ts, (allNetRx.get(ts) || 0) + v); }
          for (const [ts, v] of netTx) { allNetTx.set(ts, (allNetTx.get(ts) || 0) + v); }
        })
      );

      const toSorted = (m: Map<number, number>) =>
        Array.from(m.entries()).sort((a, b) => a[0] - b[0]);

      // Also query system-level disk history
      const diskHistory = await queryDiskHistory(fromMs, toMs, bucketMs);

      return NextResponse.json({
        series: {
          cpu: toSorted(allCpu),
          memory: toSorted(allMem),
          networkRx: toSorted(allNetRx),
          networkTx: toSorted(allNetTx),
          disk: diskHistory,
        },
      });
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
