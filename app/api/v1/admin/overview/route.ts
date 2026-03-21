import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { user, apps, deployments } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { loadTemplates } from "@/lib/templates/load";
import { getSystemHealth } from "@/lib/config/health";

// GET /api/v1/admin/overview
export async function GET() {
  try {
    await requireAppAdmin();

    const [
      [{ userCount }],
      [{ appCount }],
      [{ deploymentCount }],
      templateList,
      { resources, services },
      sparklines,
    ] = await Promise.all([
      db.select({ userCount: sql<number>`count(*)` }).from(user),
      db.select({ appCount: sql<number>`count(*)` }).from(apps),
      db.select({ deploymentCount: sql<number>`count(*)` }).from(deployments),
      loadTemplates(),
      getSystemHealth(),
      buildSparklines(30),
    ]);

    return NextResponse.json({
      stats: {
        userCount: Number(userCount),
        appCount: Number(appCount),
        deploymentCount: Number(deploymentCount),
        templateCount: templateList.length,
      },
      sparklines,
      resources,
      services,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
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
      (SELECT COUNT(*) FROM "app" WHERE created_at <= d.day + '1 day'::interval)
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
