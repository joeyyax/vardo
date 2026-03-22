import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { listContainers, getContainerLogs } from "@/lib/docker/client";
import { isLokiAvailable, queryRange, buildLogQLQuery } from "@/lib/loki/client";
import { isFeatureEnabled } from "@/lib/config/features";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/logs
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("logs")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
    }

    const { orgId, appId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
    const tail = parseInt(searchParams.get("tail") || "200");
    const since = searchParams.get("since") || "1h";
    const search = searchParams.get("search") || undefined;
    const service = searchParams.get("service") || undefined;
    const environment = searchParams.get("environment") || undefined;

    // Use Loki if available
    if (await isLokiAvailable()) {
      const query = buildLogQLQuery({
        project: app.name,
        environment,
        service,
        search,
      });

      const start = relativeToTimestamp(since);

      const entries = await queryRange({
        query,
        start,
        limit: tail,
        direction: "backward",
      });

      // Reverse so oldest is first
      entries.reverse();

      const containers = await listContainers(app.name).catch(() => []);

      return NextResponse.json({
        logs: entries.map((e) => e.line).join("\n"),
        entries: entries.map((e) => ({
          timestamp: e.timestamp,
          line: e.line,
          labels: e.labels,
        })),
        containers: containers.map((c) => ({
          id: c.id,
          name: c.name,
          state: c.state,
          image: c.image,
        })),
      });
    }

    // Docker direct fallback
    const containers = await listContainers(app.name);

    if (containers.length === 0) {
      return NextResponse.json({
        logs: "No running containers found for this app.",
        containers: [],
      });
    }

    const allLogs: string[] = [];
    for (const container of containers) {
      try {
        const log = await getContainerLogs(container.id, { tail });
        allLogs.push(`── ${container.name} ──`);
        allLogs.push(log || "(no output)");
        allLogs.push("");
      } catch (err) {
        allLogs.push(`── ${container.name} ──`);
        allLogs.push(`Error fetching logs: ${err instanceof Error ? err.message : err}`);
        allLogs.push("");
      }
    }

    return NextResponse.json({
      logs: allLogs.join("\n"),
      containers: containers.map((c) => ({
        id: c.id,
        name: c.name,
        state: c.state,
        image: c.image,
      })),
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching logs");
  }
}

function relativeToTimestamp(duration: string): string {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    return String((Date.now() - 3600_000) * 1_000_000);
  }

  const value = parseInt(match[1]);
  const unit = match[2];
  const ms: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 };

  const ago = Date.now() - value * ms[unit];
  return String(ago * 1_000_000);
}
