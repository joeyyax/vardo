import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { deployments, apps } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { scrubEnvValues } from "./get-deploy-logs";

// Tail the last 10KB of the log for status checks — enough context
// without bloating the MCP response payload.
const LOG_TAIL = 10 * 1024;

export function registerGetDeployStatus(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_get_deploy_status",
    "Get the status of a specific deployment. Returns status, timestamps, duration, git info, and the tail of the build log. Use after vardo_deploy_app to poll for completion.",
    {
      appId: z.string().describe("The app ID the deployment belongs to"),
      deploymentId: z.string().describe("The deployment ID to check"),
    },
    async ({ appId, deploymentId }) => {
      const result = await db
        .select({
          id: deployments.id,
          status: deployments.status,
          trigger: deployments.trigger,
          gitSha: deployments.gitSha,
          gitMessage: deployments.gitMessage,
          logTail: sql<string | null>`right(${deployments.log}, ${LOG_TAIL})`,
          logLength: sql<number | null>`length(${deployments.log})`,
          durationMs: deployments.durationMs,
          startedAt: deployments.startedAt,
          finishedAt: deployments.finishedAt,
          appId: apps.id,
          appName: apps.name,
        })
        .from(deployments)
        .innerJoin(apps, eq(deployments.appId, apps.id))
        .where(
          and(
            eq(deployments.id, deploymentId),
            eq(deployments.appId, appId),
            eq(apps.organizationId, context.organizationId)
          )
        )
        .then((rows) => rows[0] ?? null);

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Deployment not found or access denied" }),
            },
          ],
          isError: true,
        };
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
                logTail: result.logTail ? scrubEnvValues(result.logTail) : null,
                logTruncated: result.logLength != null && result.logLength > LOG_TAIL,
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
