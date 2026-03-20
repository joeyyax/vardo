import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, asc, desc } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { OrgMetrics } from "./org-metrics";
import { getSystemInfo } from "@/lib/docker/client";
import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";

export default async function MetricsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;

  // Fetch projects + fast initial data in parallel
  const [projectList, systemInfo, initialMetrics] = await Promise.all([
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      orderBy: [asc(projects.sortOrder), desc(projects.createdAt)],
      columns: { id: true, name: true, displayName: true, status: true },
    }),
    getSystemInfo().catch(() => null),
    fetchAllContainerMetrics().catch(() => []),
  ]);

  // Pre-aggregate initial stats per project
  const initialStats: Record<string, typeof initialMetrics> = {};
  for (const m of initialMetrics) {
    const matched = projectList.find(
      (p) => m.projectName === p.name || m.projectName.startsWith(`${p.name}-`)
    );
    if (!matched) continue;
    if (!initialStats[matched.id]) initialStats[matched.id] = [];
    initialStats[matched.id].push(m);
  }

  const initialProjectStats = projectList.map((p) => ({
    ...p,
    containers: (initialStats[p.id] || []).map((m) => ({
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
    })),
  }));

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Metrics</h1>
      </PageToolbar>

      <OrgMetrics
        orgId={orgId}
        projects={projectList}
        initialSystem={systemInfo}
        initialProjectStats={initialProjectStats}
      />
    </div>
  );
}
