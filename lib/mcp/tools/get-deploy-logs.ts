import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { deployments, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { McpAuthContext } from "../auth";

/**
 * Scrub env var values from build log output.
 *
 * Nixpacks and Railpack may echo variable assignments during the build
 * (e.g. `SECRET_KEY=abc123` or `Setting DATABASE_URL=postgres://...`).
 * This replaces the value portion of any ALL_CAPS=value token so secrets
 * don't leak to any org member with MCP access.
 *
 * Pattern: word boundary, 3+ uppercase/underscore name, `=`, non-whitespace value.
 * Intentionally broad — better to over-redact than expose credentials.
 */
function scrubEnvValues(log: string): string {
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
      // Join to apps to verify org scope
      const result = await db
        .select({
          id: deployments.id,
          status: deployments.status,
          trigger: deployments.trigger,
          gitSha: deployments.gitSha,
          gitMessage: deployments.gitMessage,
          log: deployments.log,
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
            eq(deployments.id, deployment_id),
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
                log: result.log ? scrubEnvValues(result.log) : "(no log available)",
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
