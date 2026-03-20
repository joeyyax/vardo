import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { queryMetrics } from "@/lib/metrics/store";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats/history
// Query params: from (ms), to (ms), metric (cpu|memory|networkRx|networkTx), bucket (ms)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, orgId)
      ),
      columns: { id: true, name: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const searchParams = request.nextUrl.searchParams;
    const now = Date.now();
    const from = parseInt(searchParams.get("from") || String(now - 3600000)); // default 1h
    const to = parseInt(searchParams.get("to") || String(now));
    const bucketMs = parseInt(searchParams.get("bucket") || "30000"); // default 30s

    const [cpu, memory, memoryLimit, networkRx, networkTx] = await Promise.all([
      queryMetrics(project.name, "cpu", from, to, { type: "avg", bucketMs }),
      queryMetrics(project.name, "memory", from, to, { type: "avg", bucketMs }),
      queryMetrics(project.name, "memoryLimit", from, to, { type: "max", bucketMs }),
      queryMetrics(project.name, "networkRx", from, to, { type: "sum", bucketMs }),
      queryMetrics(project.name, "networkTx", from, to, { type: "sum", bucketMs }),
    ]);

    return NextResponse.json({
      from,
      to,
      bucketMs,
      series: { cpu, memory, memoryLimit, networkRx, networkTx },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching metrics history:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
