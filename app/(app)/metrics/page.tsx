import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, asc, desc } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { OrgMetrics } from "./org-metrics";
import { getSystemInfo } from "@/lib/docker/client";
import { fetchAllContainerMetrics, type ContainerMetrics } from "@/lib/metrics/cadvisor";
import { getLatestDiskUsage } from "@/lib/metrics/store";

export default async function MetricsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;

  // Fetch apps + fast initial data in parallel
  const [appList, systemInfo, initialMetrics, cachedDisk] = await Promise.all([
    db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
      columns: { id: true, name: true, displayName: true, status: true },
    }),
    getSystemInfo().catch(() => null),
    fetchAllContainerMetrics().catch(() => []),
    getLatestDiskUsage().catch(() => null),
  ]);

  // Pre-aggregate initial stats per app
  const initialStats: Record<string, ContainerMetrics[]> = {};
  for (const m of initialMetrics) {
    const matched = appList.find(
      (a) => m.projectName === a.name || m.projectName.startsWith(`${a.name}-`)
    );
    if (!matched) continue;
    if (!initialStats[matched.id]) initialStats[matched.id] = [];
    initialStats[matched.id].push(m);
  }

  const initialAppStats = appList.map((a) => ({
    ...a,
    containers: (initialStats[a.id] || []).map((m) => ({
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
        apps={appList}
        initialSystem={systemInfo}
        initialAppStats={initialAppStats}
        initialDisk={cachedDisk}
      />
    </div>
  );
}
