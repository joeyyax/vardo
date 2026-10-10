import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getApp } from "@/lib/app-services/apps";
import { mcpActor } from "@/lib/app-services/mcp-actor";
import type { McpAuthContext } from "../auth";
import { serviceErrorResult } from "../actors";
import { accessDenied, resolveAppOrg } from "../scope";

export function registerGetAppStatus(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_get_app_status",
    "Get detailed status and configuration for a specific app. Includes recent deployments, domains, environments, and resource limits.",
    {
      appId: z.string().describe("The app ID to get status for"),
    },
    async ({ appId }) => {
      const orgId = await resolveAppOrg(context, appId, "app.view");
      const actor = orgId ? await mcpActor(context, orgId, "app.view") : null;
      if (!actor) return accessDenied("App");

      try {
        const { envVars: _envVars, ...app } = await getApp(actor, appId);
        const status = {
          ...app,
          deployments: app.deployments.slice(0, 5).map((d) => ({
            id: d.id,
            status: d.status,
            trigger: d.trigger,
            startedAt: d.startedAt,
            finishedAt: d.finishedAt,
          })),
          domains: app.domains.map((d) => ({ id: d.id, domain: d.domain, sslEnabled: d.sslEnabled })),
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ app: status }, null, 2),
            },
          ],
        };
      } catch (error) {
        return serviceErrorResult(error, "App");
      }
    }
  );
}
