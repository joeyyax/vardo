import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
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

    const orgProjects = await db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
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

      const activeNames = orgProjects.filter((p) => p.status === "active").map((p) => p.name);

      // Aggregate across all projects
      const allCpu: Map<number, number> = new Map();
      const allMem: Map<number, number> = new Map();
      const allNetRx: Map<number, number> = new Map();
      const allNetTx: Map<number, number> = new Map();

      await Promise.allSettled(
        activeNames.map(async (name) => {
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
      const projectNames = new Set(orgProjects.map((p) => p.name));

      // Group by project
      const byProject: Record<string, typeof allMetrics> = {};
      for (const m of allMetrics) {
        // Match project name (handles blue/green slots like "redis-blue")
        const matchedProject = orgProjects.find(
          (p) => m.projectName === p.name || m.projectName.startsWith(`${p.name}-`)
        );
        if (!matchedProject) continue;
        if (!byProject[matchedProject.id]) byProject[matchedProject.id] = [];
        byProject[matchedProject.id].push(m);
      }

      return NextResponse.json({
        projects: orgProjects.map((p) => ({
          ...p,
          containers: byProject[p.id] || [],
        })),
        timestamp: new Date().toISOString(),
      });
    } catch {
      // cAdvisor not available — return projects without stats
      return NextResponse.json({
        projects: orgProjects.map((p) => ({ ...p, containers: [] })),
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching org stats:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
