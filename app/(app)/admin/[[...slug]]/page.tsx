import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { user, apps, deployments, organizations, memberships } from "@/lib/db/schema";
import { loadTemplates } from "@/lib/templates/load";
import { getSession, getCurrentOrg } from "@/lib/auth/session";
import { eq, sql, asc, desc } from "drizzle-orm";
import { AdminPanel } from "../admin-panel";
import { getSystemInfo } from "@/lib/docker/client";
import { fetchAllContainerMetrics, type ContainerMetrics } from "@/lib/metrics/cadvisor";
import { getLatestDiskUsage } from "@/lib/metrics/store";
import { getAllFeatureFlags } from "@/lib/config/features";
import { getSystemHealth } from "@/lib/config/health";

const VALID_TABS = ["overview", "system", "organizations", "users", "maintenance", "metrics"] as const;
type ValidTab = (typeof VALID_TABS)[number];

type PageProps = {
  params: Promise<{ slug?: string[] }>;
};

export default async function AdminPage({ params }: PageProps) {
  const { slug } = await params;
  const activeTab: ValidTab = (slug?.[0] && VALID_TABS.includes(slug[0] as ValidTab))
    ? slug[0] as ValidTab
    : "overview";

  const session = await getSession();

  if (!session?.user?.id) {
    redirect("/login");
  }

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

  // Only fetch data needed for the active tab
  const needsStats = activeTab === "overview";
  const needsHealth = activeTab === "overview" || activeTab === "system";
  const needsOrgs = activeTab === "overview" || activeTab === "organizations";
  const needsMetrics = activeTab === "metrics";
  const needsFlags = activeTab === "system";

  // Lightweight queries (always fast)
  const featureFlags = needsFlags ? getAllFeatureFlags() : [];

  // Parallel data fetching — only what's needed
  const [
    statCounts,
    templateList,
    appList,
    allOrgs,
    allApps,
    systemHealth,
    systemInfo,
    initialMetrics,
    cachedDisk,
    sparklines,
  ] = await Promise.all([
    needsStats
      ? Promise.all([
          db.select({ userCount: sql<number>`count(*)` }).from(user),
          db.select({ appCount: sql<number>`count(*)` }).from(apps),
          db.select({ deploymentCount: sql<number>`count(*)` }).from(deployments),
          loadTemplates(),
        ])
      : Promise.resolve(null),
    needsStats ? loadTemplates() : Promise.resolve([]),
    needsMetrics
      ? db.query.apps.findMany({
          where: eq(apps.organizationId, orgId),
          orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
          columns: { id: true, name: true, displayName: true, status: true },
        })
      : Promise.resolve([]),
    needsOrgs
      ? db.query.organizations.findMany({ columns: { id: true, name: true, slug: true } })
      : Promise.resolve([]),
    needsOrgs || needsMetrics
      ? db.query.apps.findMany({
          orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
          columns: { id: true, name: true, displayName: true, status: true, organizationId: true },
        })
      : Promise.resolve([]),
    needsHealth ? getSystemHealth() : Promise.resolve({ services: [], resources: [], runtime: { nodeVersion: "", nextVersion: "", platform: "", arch: "", uptime: 0, memoryUsage: 0, memoryHeapUsed: 0, memoryHeapTotal: 0, pid: 0 }, auth: { passkeys: false, magicLink: false, github: false, passwords: false, twoFactor: false } }),
    needsMetrics ? getSystemInfo().catch(() => null) : Promise.resolve(null),
    needsOrgs || needsMetrics ? fetchAllContainerMetrics().catch(() => []) : Promise.resolve([]),
    needsMetrics ? getLatestDiskUsage().catch(() => null) : Promise.resolve(null),
    needsStats ? buildSparklines(30) : Promise.resolve({}),
  ]);

  // Stats
  const stats = statCounts
    ? {
        userCount: Number(statCounts[0][0].userCount),
        appCount: Number(statCounts[1][0].appCount),
        deploymentCount: Number(statCounts[2][0].deploymentCount),
        templateCount: statCounts[3].length,
      }
    : { userCount: 0, appCount: 0, deploymentCount: 0, templateCount: 0 };

  // Pre-aggregate metrics per app
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

  // Org breakdown
  let orgBreakdown: Parameters<typeof AdminPanel>[0]["orgBreakdown"] = [];
  if (needsOrgs && allOrgs.length > 0) {
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

    orgBreakdown = allOrgs.map((org) => {
      const orgApps = allApps.filter((a) => a.organizationId === org.id);
      let cpu = 0, memory = 0, networkRx = 0, networkTx = 0, containers = 0;
      for (const a of orgApps) {
        const s = initialStats[a.id];
        if (!s) continue;
        for (const m of s) {
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
        cpu, memory, networkRx, networkTx, containers,
      };
    });
  }

  return (
    <AdminPanel
      activeTab={activeTab}
      stats={stats}
      sparklines={sparklines as Record<string, [number, number][]>}
      featureFlags={featureFlags}
      systemHealth={systemHealth}
      orgId={orgId}
      appList={appList}
      orgBreakdown={orgBreakdown}
      initialSystem={systemInfo}
      initialAppStats={initialAppStats}
      initialDisk={cachedDisk}
    />
  );
}

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
