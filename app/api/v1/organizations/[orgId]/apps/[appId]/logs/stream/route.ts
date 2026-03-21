import { NextRequest } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { spawn } from "child_process";
import { resolve } from "path";
import { readFile } from "fs/promises";
import { createSSEResponse } from "@/lib/api/sse";
import { isLokiAvailable, queryRange, tailLogs, buildLogQLQuery } from "@/lib/loki/client";
import { isFeatureEnabled } from "@/lib/config/features";

const PROJECTS_DIR = resolve(process.env.HOST_PROJECTS_DIR || "./.host/projects");

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/logs/stream
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("logs")) {
      return new Response(JSON.stringify({ error: "Feature not enabled" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { orgId, appId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      columns: { id: true, name: true },
    });

    if (!app) {
      return new Response("Not found", { status: 404 });
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
      let appDir = resolve(PROJECTS_DIR, app.name, environmentName);
      let activeSlot = "blue";
      try {
        activeSlot = (await readFile(resolve(appDir, ".active-slot"), "utf-8")).trim();
      } catch {
        appDir = resolve(PROJECTS_DIR, app.name);
        try {
          activeSlot = (await readFile(resolve(appDir, ".active-slot"), "utf-8")).trim();
        } catch { /* default to blue */ }
      }

      const slotDir = resolve(appDir, activeSlot);
      const composePath = resolve(slotDir, "docker-compose.yml");
      const envAware = appDir.endsWith(environmentName);
      const composeProject = envAware
        ? `${app.name}-${environmentName}-${activeSlot}`
        : `${app.name}-${activeSlot}`;

      const proc = spawn("docker", [
        "compose",
        "-f", composePath,
        "-p", composeProject,
        "logs",
        "-f",
        "--tail", tail,
        "--no-log-prefix",
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
