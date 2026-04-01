import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { McpAuthContext } from "../auth";

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
        where: and(
          eq(apps.id, appId),
          eq(apps.organizationId, context.organizationId)
        ),
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
