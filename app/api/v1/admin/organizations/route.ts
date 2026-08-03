import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { apps, organizations, memberships, deployments } from "@/lib/db/schema";
import { eq, sql, asc, desc } from "drizzle-orm";
import { fetchAllMetrics } from "@/lib/metrics/provider";
import { groupMetricsByApp, dedupeMetrics } from "@/lib/metrics/app-match";
import { METRICS_APP_COLUMNS } from "@/lib/metrics/app-columns";
import { isMetricsEnabled } from "@/lib/metrics/config";

// GET /api/v1/admin/organizations
export async function GET() {
  try {
    await requireAppAdmin();

    const [allOrgs, allApps, memberCounts, deploymentCounts, metrics] = await Promise.all([
      db.query.organizations.findMany({
        columns: { id: true, name: true, slug: true, trusted: true },
      }),
      db.query.apps.findMany({
        orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
        columns: { ...METRICS_APP_COLUMNS, displayName: true },
      }),
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
      isMetricsEnabled() ? fetchAllMetrics().catch(() => []) : Promise.resolve([]),
    ]);

    const memberCountMap = new Map(memberCounts.map((r) => [r.organizationId, Number(r.count)]));
    const deploymentCountMap = new Map(deploymentCounts.map((r) => [r.organizationId, Number(r.count)]));

    const metricsByApp = groupMetricsByApp(allApps, metrics);

    const result = allOrgs.map((org) => {
      const orgApps = allApps.filter((a) => a.organizationId === org.id);
      // A stack child's containers are a subset of its parent's — dedupe or the
      // org total counts them twice.
      const orgMetrics = dedupeMetrics(orgApps.map((a) => metricsByApp.get(a.id) ?? []));
      let cpu = 0, memory = 0, networkRx = 0, networkTx = 0, containers = 0;
      for (const m of orgMetrics) {
        cpu += m.cpuPercent;
        memory += m.memoryUsage;
        networkRx += m.networkRxBytes;
        networkTx += m.networkTxBytes;
        containers++;
      }
      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        trusted: org.trusted,
        memberCount: memberCountMap.get(org.id) ?? 0,
        appCount: orgApps.length,
        activeApps: orgApps.filter((a) => a.status === "active").length,
        deploymentCount: deploymentCountMap.get(org.id) ?? 0,
        cpu, memory, networkRx, networkTx, containers,
      };
    });

    return NextResponse.json({ organizations: result });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error fetching organizations");
  }
}
