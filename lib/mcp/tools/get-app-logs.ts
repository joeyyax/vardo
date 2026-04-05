import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  isLokiAvailable,
  queryRange,
  buildLogQLQuery,
} from "@/lib/logging/client";
import { listContainers, getContainerLogs } from "@/lib/docker/client";
import type { McpAuthContext } from "../auth";

export function registerGetAppLogs(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_get_app_logs",
    "Get recent logs for an app. Uses Loki if available, falls back to Docker logs. Returns log lines with optional filtering by service, environment, or search term.",
    {
      appId: z.string().describe("The app ID to get logs for"),
      lines: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Number of log lines to return (1-1000, default 100)"),
      since: z
        .string()
        .default("1h")
        .describe("Time range — e.g. '30m', '1h', '6h', '1d'"),
      search: z
        .string()
        .optional()
        .describe("Filter logs by search term (case-insensitive)"),
      service: z
        .string()
        .optional()
        .describe("Filter by service name (for compose apps)"),
    },
    async ({ appId, lines, since, search, service }) => {
      const app = await db.query.apps.findFirst({
        where: and(
          eq(apps.id, appId),
          eq(apps.organizationId, context.organizationId)
        ),
        columns: { id: true, name: true },
      });

      if (!app) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "App not found or access denied" }),
            },
          ],
          isError: true,
        };
      }

      // Try Loki first
      if (await isLokiAvailable()) {
        const query = buildLogQLQuery({
          project: app.name,
          service,
          search,
        });

        const start = relativeToTimestamp(since);

        const entries = await queryRange({
          query,
          start,
          limit: lines,
          direction: "backward",
        });

        entries.reverse();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  source: "loki",
                  app: app.name,
                  lineCount: entries.length,
                  logs: entries.map((e) => e.line).join("\n"),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Docker direct fallback
      const containers = await listContainers(app.name);

      if (containers.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                source: "docker",
                app: app.name,
                lineCount: 0,
                logs: "No running containers found for this app.",
              }),
            },
          ],
        };
      }

      const allLogs: string[] = [];
      for (const container of containers) {
        try {
          const log = await getContainerLogs(container.id, { tail: lines });
          allLogs.push(`── ${container.name} ──`);
          allLogs.push(log || "(no output)");
          allLogs.push("");
        } catch (err) {
          allLogs.push(`── ${container.name} ──`);
          allLogs.push(
            `Error: ${err instanceof Error ? err.message : String(err)}`
          );
          allLogs.push("");
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                source: "docker",
                app: app.name,
                containerCount: containers.length,
                logs: allLogs.join("\n"),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

function relativeToTimestamp(duration: string): string {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    return String((Date.now() - 3600_000) * 1_000_000);
  }

  const value = parseInt(match[1]);
  const unit = match[2];
  const ms: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3600_000,
    d: 86400_000,
  };

  const ago = Date.now() - value * ms[unit];
  return String(ago * 1_000_000);
}
