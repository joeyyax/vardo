import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { spawn } from "child_process";
import { resolve } from "path";
import { readlink } from "fs/promises";
import { createSSEResponse } from "@/lib/api/sse";
import { isLokiAvailable, queryRange, tailLogs, buildLogQLQuery } from "@/lib/logging/client";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { appEnvDir, appBaseDir } from "@/lib/paths";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

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

    // Compose decomposition: a child app (parentAppId set) doesn't have
    // its own deploy directory — its containers live under the parent's
    // /opt/vardo/apps/<parent>/<env>/<slot>/. Resolve the parent's name
    // and scope `docker compose logs` to just this child's service so
    // we still tail only the right container.
    let logRootName = app.name;
    let scopeService: string | null = null;
    if (app.parentAppId) {
      const parent = await db.query.apps.findFirst({
        where: eq(apps.id, app.parentAppId),
        columns: { name: true },
      });
      if (parent) {
        logRootName = parent.name;
        scopeService = app.composeService;
      }
    }

    const searchParams = request.nextUrl.searchParams;
    const tail = searchParams.get("tail") || "200";
    const environmentName = searchParams.get("environment") || "production";
    const search = searchParams.get("search") || undefined;
    const service = searchParams.get("service") || undefined;

    // Use Loki if available, otherwise fall back to Docker compose logs
    if (await isLokiAvailable()) {
      const query = buildLogQLQuery({
        project: app.name,
        environment: environmentName,
        service,
        search,
      });

      return createSSEResponse(request, async (sendEvent) => {
        sendEvent("source", "loki");

        // Backfill recent history so the viewer has content immediately
        try {
          const tailCount = parseInt(tail);
          const start = String((Date.now() - 3600_000) * 1_000_000);
          const history = await queryRange({
            query,
            start,
            limit: tailCount,
            direction: "backward",
          });
          history.reverse();
          for (const entry of history) {
            sendEvent("log", entry.line);
          }
        } catch {
          // History unavailable — continue to live tail
        }

        // Live tail via WebSocket
        const tailStart = String(Date.now() * 1_000_000);
        await tailLogs(
          { query, start: tailStart, delayFor: 2 },
          (entry) => sendEvent("log", entry.line),
          request.signal,
        );
      });
    }

    // Docker compose logs fallback
    return createSSEResponse(request, async (sendEvent) => {
      sendEvent("source", "docker");

      let appDir = appEnvDir(logRootName, environmentName);
      let activeSlot = "blue";
      try {
        activeSlot = (await readlink(resolve(appDir, "current"))).trim();
      } catch {
        appDir = appBaseDir(logRootName);
        try {
          activeSlot = (await readlink(resolve(appDir, "current"))).trim();
        } catch { /* default to blue */ }
      }

      const slotDir = resolve(appDir, activeSlot);
      const composePath = resolve(slotDir, "docker-compose.yml");
      const envAware = appDir.endsWith(environmentName);
      const composeProject = envAware
        ? `${logRootName}-${environmentName}-${activeSlot}`
        : `${logRootName}-${activeSlot}`;

      const proc = spawn("docker", [
        "compose",
        "-f", composePath,
        "-p", composeProject,
        "logs",
        "-f",
        "--tail", tail,
        "--no-log-prefix",
        ...(scopeService ? [scopeService] : []),
      ], { cwd: slotDir });

      proc.stdout.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line) sendEvent("log", line);
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line) sendEvent("log", line);
        }
      });

      proc.on("error", (err) => {
        sendEvent("log", `[error] ${err.message}`);
      });

      request.signal.addEventListener("abort", () => {
        proc.kill();
      });

      await new Promise<void>((resolve) => {
        proc.on("close", () => resolve());
      });
    });
  } catch (error) {
    return handleRouteError(error, "Error streaming logs");
  }
}
