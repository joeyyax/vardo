import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { user, apps, deployments, templates } from "@/lib/db/schema";
import { getSession, getCurrentOrg } from "@/lib/auth/session";
import { eq, sql, asc, desc } from "drizzle-orm";
import { AdminPanel } from "./admin-panel";
import { getSystemInfo } from "@/lib/docker/client";
import { fetchAllContainerMetrics, type ContainerMetrics } from "@/lib/metrics/cadvisor";
import { getLatestDiskUsage } from "@/lib/metrics/store";

export default async function AdminPage() {
  const session = await getSession();

  if (!session?.user?.id) {
    redirect("/login");
  }

  // Check admin status
  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, session.user.id),
    columns: { isAppAdmin: true },
  });

  if (!dbUser?.isAppAdmin) {
    redirect("/projects");
  }

  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");
  const orgId = orgData.organization.id;

  // Gather stats + metrics data in parallel
  const [
    [{ userCount }],
    [{ appCount }],
    [{ deploymentCount }],
    [{ templateCount }],
    appList,
    systemInfo,
    initialMetrics,
    cachedDisk,
  ] = await Promise.all([
    db.select({ userCount: sql<number>`count(*)` }).from(user),
    db.select({ appCount: sql<number>`count(*)` }).from(apps),
    db.select({ deploymentCount: sql<number>`count(*)` }).from(deployments),
    db.select({ templateCount: sql<number>`count(*)` }).from(templates),
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

  const stats = {
    userCount: Number(userCount),
    appCount: Number(appCount),
    deploymentCount: Number(deploymentCount),
    templateCount: Number(templateCount),
  };

  return (
    <AdminPanel
      stats={stats}
      orgId={orgId}
      appList={appList}
      initialSystem={systemInfo}
      initialAppStats={initialAppStats}
      initialDisk={cachedDisk}
    />
  );
}
