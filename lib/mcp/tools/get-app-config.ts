import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

export function registerGetAppConfig(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_get_app_config",
    "Get the full configuration for a specific app. Returns all settings including deploy type, git config, resource limits, domains, env var keys (not values), and recent deployments.",
    {
      appId: z.string().describe("The app ID to get config for"),
    },
    async ({ appId }) => {
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
        with: {
          deployments: {
            orderBy: (d, { desc }) => [desc(d.startedAt)],
            limit: 10,
          },
          domains: true,
          envVars: {
            columns: { id: true, key: true, isSecret: true, createdAt: true, updatedAt: true },
          },
        },
      });

      if (!app || !(await canAccessOrg(context, app.organizationId))) {
        return accessDenied("App");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ app }, null, 2),
          },
        ],
      };
    }
  );
}
