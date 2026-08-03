import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

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
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
        with: {
          deployments: {
            columns: {
              id: true,
              status: true,
              trigger: true,
              startedAt: true,
              finishedAt: true,
            },
            orderBy: (d, { desc }) => [desc(d.startedAt)],
            limit: 5,
          },
          project: {
            columns: { id: true, name: true, displayName: true },
          },
          domains: {
            columns: { id: true, domain: true, sslEnabled: true },
          },
          environments: {
            columns: { id: true, name: true, type: true, isDefault: true },
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
