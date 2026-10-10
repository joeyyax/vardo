import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { user, apps, deployments, organizations } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { loadTemplates } from "@/lib/templates/load";
import { getSystemHealth } from "@/lib/config/health";

// GET /api/v1/admin/overview
async function handleGet() {
  try {
    await requireAppAdmin();

    const [
      [{ userCount }],
      [{ appCount, composeServiceCount }],
      [{ deploymentCount }],
      templateList,
      sparklines,
    ] = await Promise.all([
      db.select({ userCount: sql<number>`count(*)` }).from(user),
      // Excludes the system org (Vardo's stack and core services).
      db
        .select({
          appCount: sql<number>`count(*)`,
          composeServiceCount: sql<number>`count(*) filter (where ${apps.parentAppId} is not null)`,
        })
        .from(apps)
        .innerJoin(organizations, eq(apps.organizationId, organizations.id))
        .where(eq(organizations.isSystemManaged, false)),
      db.select({ deploymentCount: sql<number>`count(*)` }).from(deployments),
      loadTemplates(),
      buildSparklines(30),
    ]);

    const { resources, services, runtime } = await getSystemHealth();

    return NextResponse.json({
      stats: {
        userCount: Number(userCount),
        appCount: Number(appCount),
        composeServiceCount: Number(composeServiceCount),
        deploymentCount: Number(deploymentCount),
        templateCount: templateList.length,
      },
      sparklines,
      resources,
      services,
      runtime,
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching admin overview");
  }
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
    SELECT 'users' AS metric, d.day,
      (SELECT COUNT(*) FROM "user" WHERE created_at <= d.day + '1 day'::interval) AS count
    FROM days d
    UNION ALL
    SELECT 'apps', d.day,
      (SELECT COUNT(*) FROM "app" a
        JOIN "organization" o ON o.id = a.organization_id
        WHERE o.is_system_managed = false AND a.created_at <= d.day + '1 day'::interval)
    FROM days d
    UNION ALL
    SELECT 'deployments', d.day,
      (SELECT COUNT(*) FROM "deployment" WHERE started_at <= d.day + '1 day'::interval)
    FROM days d
    ORDER BY metric, day
  `);

  const sparklines: Record<string, [number, number][]> = { users: [], apps: [], deployments: [] };
  for (const row of results as unknown as { metric: string; day: string; count: string }[]) {
    const ts = new Date(row.day).getTime();
    const val = parseInt(row.count);
    if (sparklines[row.metric]) sparklines[row.metric].push([ts, val]);
  }
  return sparklines;
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/overview" });
