import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { deployments, apps } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

// Characters, not bytes; build logs can exceed 10MB.
const LOG_CAP = 100 * 1024;

/** Redacts the value of every ALL_CAPS=value token in build logs. Broad on purpose. */
export function scrubEnvValues(log: string): string {
  return log.replace(/\b([A-Z_][A-Z0-9_]{2,})=([^\s"'\n]+)/g, "$1=[redacted]");
}

export function registerGetDeployLogs(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_get_deploy_logs",
    "Get the build and deployment logs for a specific deployment. Returns the full log output captured during the deploy process.",
    {
      deployment_id: z
        .string()
        .describe("The deployment ID to get logs for"),
    },
    async ({ deployment_id }) => {
      // Org-scoped via apps; fetches only the last LOG_CAP characters.
      const result = await db
        .select({
          id: deployments.id,
          status: deployments.status,
          trigger: deployments.trigger,
          gitSha: deployments.gitSha,
          gitMessage: deployments.gitMessage,
          log: sql<string | null>`right(${deployments.log}, ${LOG_CAP})`,
          logLength: sql<number | null>`length(${deployments.log})`,
          durationMs: deployments.durationMs,
          startedAt: deployments.startedAt,
          finishedAt: deployments.finishedAt,
          appId: apps.id,
          appName: apps.name,
          organizationId: apps.organizationId,
        })
        .from(deployments)
        .innerJoin(apps, eq(deployments.appId, apps.id))
        .where(eq(deployments.id, deployment_id))
        .then((rows) => rows[0] ?? null);

      if (!result || !(await canAccessOrg(context, result.organizationId, "app.view"))) {
        return accessDenied("Deployment");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                deployment: {
                  id: result.id,
                  status: result.status,
                  trigger: result.trigger,
                  gitSha: result.gitSha,
                  gitMessage: result.gitMessage,
                  durationMs: result.durationMs,
                  startedAt: result.startedAt,
                  finishedAt: result.finishedAt,
                  appId: result.appId,
                  appName: result.appName,
                },
                log: result.log ? scrubEnvValues(result.log) : "(no log available)",
                logTruncated: result.logLength != null && result.logLength > LOG_CAP,
                logLength: result.logLength,
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
