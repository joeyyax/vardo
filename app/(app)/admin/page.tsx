import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { user, apps, deployments, organizations, memberships } from "@/lib/db/schema";
import { loadTemplates } from "@/lib/templates/load";
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
    templateList,
    appList,
    allOrgs,
    allApps,
    systemInfo,
    initialMetrics,
    cachedDisk,
  ] = await Promise.all([
    db.select({ userCount: sql<number>`count(*)` }).from(user),
    db.select({ appCount: sql<number>`count(*)` }).from(apps),
    db.select({ deploymentCount: sql<number>`count(*)` }).from(deployments),
    loadTemplates(),
    db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
      columns: { id: true, name: true, displayName: true, status: true },
    }),
    db.query.organizations.findMany({
      columns: { id: true, name: true, slug: true },
    }),
    db.query.apps.findMany({
      orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
      columns: { id: true, name: true, displayName: true, status: true, organizationId: true },
    }),
    getSystemInfo().catch(() => null),
    fetchAllContainerMetrics().catch(() => []),
    getLatestDiskUsage().catch(() => null),
  ]);

  // Pre-aggregate initial stats per app (match against all apps for admin view)
  const initialStats: Record<string, ContainerMetrics[]> = {};
  for (const m of initialMetrics) {
    const matched = allApps.find(
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
    templateCount: templateList.length,
  };

  // Build org breakdown from live metrics + DB counts
  const [memberCounts, deploymentCounts] = await Promise.all([
    db.select({
      organizationId: memberships.organizationId,
      count: sql<number>`count(*)`,
    }).from(memberships).groupBy(memberships.organizationId),
    db.select({
      organizationId: apps.organizationId,
      count: sql<number>`count(*)`,
    }).from(deployments)
      .innerJoin(apps, eq(deployments.appId, apps.id))
      .groupBy(apps.organizationId),
  ]);

  const memberCountMap = new Map(memberCounts.map((r) => [r.organizationId, Number(r.count)]));
  const deploymentCountMap = new Map(deploymentCounts.map((r) => [r.organizationId, Number(r.count)]));

  const orgBreakdown = allOrgs.map((org) => {
    const orgApps = allApps.filter((a) => a.organizationId === org.id);
    let cpu = 0, memory = 0, networkRx = 0, networkTx = 0, containers = 0;
    for (const a of orgApps) {
      const stats = initialStats[a.id];
      if (!stats) continue;
      for (const m of stats) {
        cpu += m.cpuPercent;
        memory += m.memoryUsage;
        networkRx += m.networkRxBytes;
        networkTx += m.networkTxBytes;
        containers++;
      }
    }
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      memberCount: memberCountMap.get(org.id) ?? 0,
      appCount: orgApps.length,
      activeApps: orgApps.filter((a) => a.status === "active").length,
      deploymentCount: deploymentCountMap.get(org.id) ?? 0,
      cpu,
      memory,
      networkRx,
      networkTx,
      containers,
    };
  });

  // Build sparklines from cumulative counts over the last 30 days
  // This works immediately — no collector history needed
  const now = Date.now();
  const sparklineDays = 30;
  const sparklines = await buildSparklines(sparklineDays);

  return (
    <AdminPanel
      stats={stats}
      sparklines={sparklines}
      orgId={orgId}
      appList={appList}
      orgBreakdown={orgBreakdown}
      initialSystem={systemInfo}
      initialAppStats={initialAppStats}
      initialDisk={cachedDisk}
    />
  );
}

/**
 * Build sparkline data from cumulative entity counts.
 * For each day in the range, counts how many rows existed by that day
 * using created_at timestamps. Works immediately with no collector history.
 */
async function buildSparklines(days: number): Promise<Record<string, [number, number][]>> {
  const results = await db.execute(sql`
    WITH days AS (
      SELECT generate_series(
        NOW() - ${days + ' days'}::interval,
        NOW(),
        '1 day'::interval
      )::date AS day
    )
    SELECT
      'users' AS metric,
      d.day,
      (SELECT COUNT(*) FROM "user" WHERE created_at <= d.day + '1 day'::interval) AS count
    FROM days d
    UNION ALL
    SELECT
      'apps' AS metric,
      d.day,
      (SELECT COUNT(*) FROM "app" WHERE created_at <= d.day + '1 day'::interval) AS count
    FROM days d
    UNION ALL
    SELECT
      'deployments' AS metric,
      d.day,
      (SELECT COUNT(*) FROM "deployment" WHERE started_at <= d.day + '1 day'::interval) AS count
    FROM days d
    ORDER BY metric, day
  `);

  const sparklines: Record<string, [number, number][]> = {
    users: [],
    apps: [],
    deployments: [],
  };

  for (const row of results as unknown as { metric: string; day: string; count: string }[]) {
    const ts = new Date(row.day).getTime();
    const val = parseInt(row.count);
    if (sparklines[row.metric]) {
      sparklines[row.metric].push([ts, val]);
    }
  }

  return sparklines;
}
