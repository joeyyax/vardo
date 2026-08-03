import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { spawn } from "child_process";
import { createSSEResponse } from "@/lib/api/sse";
import { isLokiAvailable, tailLogs, buildLogQLQuery } from "@/lib/logging/client";
import { readLogHistory, resolveComposeTarget } from "@/lib/logging/history";
import { resolveLogScope, type LogScope } from "@/lib/logging/scope";
import { parseComposeLine, type ServiceLine } from "@/lib/logging/compose-lines";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

type SendEvent = (event: string, data: unknown) => void;

// GET /api/v1/organizations/[orgId]/apps/[appId]/logs/stream
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return new Response("Forbidden", { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true, name: true, parentAppId: true, composeService: true },
    });

    if (!app) {
      return new Response("Not found", { status: 404 });
    }

    const searchParams = request.nextUrl.searchParams;
    const tail = parseInt(searchParams.get("tail") || "200");
    const environmentName = searchParams.get("environment") || "production";
    const search = searchParams.get("search") || undefined;
    const allServices = searchParams.get("services") === "all";

    const scope = await resolveLogScope(app, { allServices });

    if (await isLokiAvailable()) {
      const query = buildLogQLQuery({
        project: scope.project,
        environment: environmentName,
        service: scope.service ?? undefined,
        search,
      });

      return createSSEResponse(request, async (sendEvent) => {
        await sendInit(sendEvent, "loki", orgId, scope, environmentName, search, tail);

        await tailLogs(
          { query, organizationId: orgId, start: String(Date.now() * 1_000_000), delayFor: 2 },
          (entry) => sendEvent("logs", [{
            text: entry.line,
            service: scope.prefixed ? entry.labels.service : undefined,
          }]),
          request.signal,
        );
      });
    }

    // Docker compose logs fallback
    return createSSEResponse(request, async (sendEvent) => {
      const target = await resolveComposeTarget(scope.project, environmentName);

      // Follow first, backfill second: anything written while history is read
      // is held here rather than lost between the two calls.
      const pending: ServiceLine[] = [];
      let live = false;

      const proc = spawn("docker", [
        "compose",
        "-f", target.composePath,
        "-p", target.composeProject,
        "logs",
        "-f",
        "--no-color",
        "--tail", "0",
        ...(scope.prefixed ? [] : ["--no-log-prefix", ...(scope.service ? [scope.service] : [])]),
      ], { cwd: target.slotDir });

      // Whole chunks go out as one event — a per-line loop outruns the SSE
      // queue and the surplus lines are dropped.
      function forward(chunk: Buffer) {
        const raw = chunk.toString().split("\n").filter(Boolean);
        if (raw.length === 0) return;
        const lines = scope.prefixed ? raw.map(parseComposeLine) : raw.map((text) => ({ text }));
        if (!live) {
          pending.push(...lines);
          return;
        }
        sendEvent("logs", lines);
      }

      proc.stdout.on("data", forward);
      proc.stderr.on("data", forward);

      proc.on("error", (err) => {
        sendEvent("logs", [{ text: `[error] ${err.message}` }]);
      });

      request.signal.addEventListener("abort", () => {
        proc.kill();
      });

      await sendInit(sendEvent, "docker", orgId, scope, environmentName, search, tail);
      live = true;
      if (pending.length > 0) sendEvent("logs", pending.splice(0));

      await new Promise<void>((resolve) => {
        proc.on("close", () => resolve());
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error streaming logs");
  }
}

/**
 * Source, service list and backfill in a single event. The SSE queue only
 * admits one chunk before the client pulls, so opening sends must not be split.
 */
async function sendInit(
  sendEvent: SendEvent,
  source: "loki" | "docker",
  organizationId: string,
  scope: LogScope,
  environment: string,
  search: string | undefined,
  tail: number,
) {
  let lines: ServiceLine[] = [];
  try {
    const history = await readLogHistory({
      project: scope.project,
      organizationId,
      environment,
      service: scope.service,
      prefixed: scope.prefixed,
      search,
      tail,
    });
    lines = history.lines;
  } catch {
    // Backfill unavailable — the live tail still runs
  }

  sendEvent("init", { source, services: scope.services, lines });
}
