import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { queryMetrics } from "@/lib/metrics/store";
import { isMetricsEnabled } from "@/lib/metrics/config";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/stats/history
// Query params: from (ms), to (ms), metric (cpu|memory|networkRx|networkTx), bucket (ms)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!isMetricsEnabled()) {
      return NextResponse.json({ series: {} });
    }

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true, name: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const searchParams = request.nextUrl.searchParams;
    const now = Date.now();
    const from = parseInt(searchParams.get("from") || String(now - 3600000)); // default 1h
    const to = parseInt(searchParams.get("to") || String(now));
    const bucketMs = parseInt(searchParams.get("bucket") || "30000"); // default 30s

    const [cpu, memory, memoryLimit, networkRx, networkTx] = await Promise.all([
      queryMetrics(app.name, "cpu", from, to, { type: "avg", bucketMs }),
      queryMetrics(app.name, "memory", from, to, { type: "avg", bucketMs }),
      queryMetrics(app.name, "memoryLimit", from, to, { type: "max", bucketMs }),
      queryMetrics(app.name, "networkRx", from, to, { type: "sum", bucketMs }),
      queryMetrics(app.name, "networkTx", from, to, { type: "sum", bucketMs }),
    ]);

    return NextResponse.json({
      from,
      to,
      bucketMs,
      series: { cpu, memory, memoryLimit, networkRx, networkTx },
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching metrics history");
  }
}
