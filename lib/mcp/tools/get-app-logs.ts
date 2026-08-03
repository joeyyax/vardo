import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  isLokiAvailable,
  queryRange,
  buildLogQLQuery,
} from "@/lib/logging/client";
import { LOOKBACK_MS } from "@/lib/logging/history";
import { listContainers, getContainerLogs } from "@/lib/docker/client";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

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
        .describe(
          `Time range — e.g. '30m', '1h', '6h', '1d'. Anything past ${formatDuration(MAX_SINCE_MS)} is clamped to it and the response says so.`
        ),
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
        where: eq(apps.id, appId),
        columns: { id: true, name: true, organizationId: true },
      });

      if (!app || !(await canAccessOrg(context, app.organizationId))) {
        return accessDenied("App");
      }

      // Try Loki first
      if (await isLokiAvailable()) {
        const query = buildLogQLQuery({
          project: app.name,
          service,
          search,
        });

        const window = resolveSince(since);

        const entries = await queryRange({
          query,
          organizationId: app.organizationId,
          start: window.start,
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
                  since: window.since,
                  ...(window.clamped && {
                    requestedSince: since,
                    truncated: `Loki keeps ${window.since} of logs, so this covers ${window.since} rather than the ${since} requested.`,
                  }),
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
      const containers = await listContainers(app);

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

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3600_000,
  d: 86400_000,
};

const DEFAULT_SINCE_MS = UNIT_MS.h;

/** Deepest window Loki still holds — the log viewer's widest lookback, which retention is sized to. */
export const MAX_SINCE_MS = Math.max(...LOOKBACK_MS);

/** The window a request actually covers, and whether that is less than it asked for. */
export type SinceWindow = { start: string; since: string; clamped: boolean };

export function resolveSince(duration: string, now: number = Date.now()): SinceWindow {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  const requested = match ? parseInt(match[1]) * UNIT_MS[match[2]] : DEFAULT_SINCE_MS;
  const covered = Math.min(requested, MAX_SINCE_MS);

  return {
    start: String((now - covered) * 1_000_000),
    since: formatDuration(covered),
    clamped: covered < requested,
  };
}

/** Largest whole unit the span divides into, so 30 days reads as "30d". */
function formatDuration(ms: number): string {
  for (const unit of ["d", "h", "m", "s"]) {
    if (ms >= UNIT_MS[unit] && ms % UNIT_MS[unit] === 0) return `${ms / UNIT_MS[unit]}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
}
