import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import type { McpAuthContext } from "../auth";

export function registerListApps(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_list_apps",
    "List all apps in the organization. Returns app name, status, deploy type, project, and latest deployment info.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe("Max apps to return (1-100, default 50)"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Offset for pagination"),
    },
    async ({ limit, offset }) => {
      const appList = await db.query.apps.findMany({
        where: eq(apps.organizationId, context.organizationId),
        with: {
          deployments: {
            columns: { id: true, status: true, startedAt: true },
            orderBy: (d, { desc }) => [desc(d.startedAt)],
            limit: 1,
          },
          project: {
            columns: { id: true, name: true, displayName: true },
          },
        },
        columns: {
          id: true,
          name: true,
          displayName: true,
          status: true,
          deployType: true,
          source: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [desc(apps.createdAt)],
        limit,
        offset,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ apps: appList, count: appList.length }, null, 2),
          },
        ],
      };
    }
  );
}
