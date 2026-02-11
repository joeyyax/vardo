import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { siteHeartbeats, scopeClients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, sql, desc } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; scopeClientId: string }>;
};

const PERIOD_MS: Record<string, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

// GET /api/v1/organizations/[orgId]/scope-clients/[scopeClientId]/health
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, scopeClientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify scope client belongs to org
    const sc = await db.query.scopeClients.findFirst({
      where: and(
        eq(scopeClients.id, scopeClientId),
        eq(scopeClients.organizationId, orgId)
      ),
      columns: { id: true },
    });

    if (!sc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const periodMs = PERIOD_MS[period] || PERIOD_MS["7d"];
    const since = new Date(Date.now() - periodMs);
    const periodDays = periodMs / (24 * 60 * 60 * 1000);

    const conditions = and(
      eq(siteHeartbeats.scopeClientId, scopeClientId),
      gte(siteHeartbeats.createdAt, since)
    );

    // Summary aggregation
    const [summary] = await db
      .select({
        totalPageviews: sql<number>`count(*)::int`,
        avgLoadMs: sql<number>`avg((${siteHeartbeats.metrics}->>'navigation'->>'load')::numeric)`,
        avgTtfbMs: sql<number>`avg((${siteHeartbeats.metrics}->'navigation'->>'ttfb')::numeric)`,
        avgLcp: sql<number>`avg((${siteHeartbeats.metrics}->'vitals'->>'lcp')::numeric)`,
        avgCls: sql<number>`avg((${siteHeartbeats.metrics}->'vitals'->>'cls')::numeric)`,
        avgInp: sql<number>`avg((${siteHeartbeats.metrics}->'vitals'->>'inp')::numeric)`,
        totalJsErrors: sql<number>`sum((${siteHeartbeats.metrics}->'errors'->>'jsErrors')::int)`,
        totalConsoleErrors: sql<number>`sum((${siteHeartbeats.metrics}->'errors'->>'consoleErrors')::int)`,
        totalResourceFailures: sql<number>`sum((${siteHeartbeats.metrics}->'errors'->>'resourceFailures')::int)`,
      })
      .from(siteHeartbeats)
      .where(conditions);

    // Count distinct hours with heartbeats for uptime calculation
    const [uptimeResult] = await db
      .select({
        activeHours: sql<number>`count(DISTINCT date_trunc('hour', ${siteHeartbeats.createdAt}))::int`,
      })
      .from(siteHeartbeats)
      .where(conditions);

    const totalHours = periodDays * 24;
    const activeHours = uptimeResult?.activeHours ?? 0;
    const uptimePercent = totalHours > 0 ? Math.round((activeHours / totalHours) * 10000) / 100 : 0;

    const totalPageviews = summary?.totalPageviews ?? 0;
    const totalErrors = (summary?.totalJsErrors ?? 0) + (summary?.totalConsoleErrors ?? 0) + (summary?.totalResourceFailures ?? 0);
    const errorRate = totalPageviews > 0 ? Math.round((totalErrors / totalPageviews) * 100) / 100 : 0;

    // Daily timeseries
    const timeseries = await db
      .select({
        date: sql<string>`date_trunc('day', ${siteHeartbeats.createdAt})::date::text`,
        pageviews: sql<number>`count(*)::int`,
        avgLoadMs: sql<number>`avg((${siteHeartbeats.metrics}->'navigation'->>'load')::numeric)`,
        avgTtfbMs: sql<number>`avg((${siteHeartbeats.metrics}->'navigation'->>'ttfb')::numeric)`,
        errorCount: sql<number>`sum(
          COALESCE((${siteHeartbeats.metrics}->'errors'->>'jsErrors')::int, 0) +
          COALESCE((${siteHeartbeats.metrics}->'errors'->>'consoleErrors')::int, 0) +
          COALESCE((${siteHeartbeats.metrics}->'errors'->>'resourceFailures')::int, 0)
        )::int`,
        avgLcp: sql<number>`avg((${siteHeartbeats.metrics}->'vitals'->>'lcp')::numeric)`,
        avgCls: sql<number>`avg((${siteHeartbeats.metrics}->'vitals'->>'cls')::numeric)`,
      })
      .from(siteHeartbeats)
      .where(conditions)
      .groupBy(sql`date_trunc('day', ${siteHeartbeats.createdAt})`)
      .orderBy(sql`date_trunc('day', ${siteHeartbeats.createdAt})`);

    // Top pages
    const topPages = await db
      .select({
        pageUrl: siteHeartbeats.pageUrl,
        views: sql<number>`count(*)::int`,
        avgLoadMs: sql<number>`avg((${siteHeartbeats.metrics}->'navigation'->>'load')::numeric)`,
        errorCount: sql<number>`sum(
          COALESCE((${siteHeartbeats.metrics}->'errors'->>'jsErrors')::int, 0) +
          COALESCE((${siteHeartbeats.metrics}->'errors'->>'consoleErrors')::int, 0) +
          COALESCE((${siteHeartbeats.metrics}->'errors'->>'resourceFailures')::int, 0)
        )::int`,
      })
      .from(siteHeartbeats)
      .where(conditions)
      .groupBy(siteHeartbeats.pageUrl)
      .orderBy(sql`count(*) desc`)
      .limit(20);

    // Recent heartbeats with errors
    const recentErrors = await db
      .select({
        pageUrl: siteHeartbeats.pageUrl,
        timestamp: siteHeartbeats.createdAt,
        metrics: siteHeartbeats.metrics,
      })
      .from(siteHeartbeats)
      .where(
        and(
          conditions,
          sql`(
            COALESCE((${siteHeartbeats.metrics}->'errors'->>'jsErrors')::int, 0) +
            COALESCE((${siteHeartbeats.metrics}->'errors'->>'consoleErrors')::int, 0) +
            COALESCE((${siteHeartbeats.metrics}->'errors'->>'resourceFailures')::int, 0)
          ) > 0`
        )
      )
      .orderBy(desc(siteHeartbeats.createdAt))
      .limit(20);

    const recentErrorsMapped = recentErrors.map((r) => {
      const errors = (r.metrics as Record<string, Record<string, number>>)?.errors ?? {};
      return {
        pageUrl: r.pageUrl,
        timestamp: r.timestamp,
        jsErrors: errors.jsErrors ?? 0,
        consoleErrors: errors.consoleErrors ?? 0,
        resourceFailures: errors.resourceFailures ?? 0,
      };
    });

    return NextResponse.json({
      summary: {
        uptimePercent,
        avgLoadMs: Math.round(summary?.avgLoadMs ?? 0),
        avgTtfbMs: Math.round(summary?.avgTtfbMs ?? 0),
        errorRate,
        totalPageviews,
        vitals: {
          lcp: summary?.avgLcp ? Math.round(summary.avgLcp) : null,
          cls: summary?.avgCls ? Math.round(summary.avgCls * 1000) / 1000 : null,
          inp: summary?.avgInp ? Math.round(summary.avgInp) : null,
        },
      },
      timeseries,
      topPages,
      recentErrors: recentErrorsMapped,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching site health:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
