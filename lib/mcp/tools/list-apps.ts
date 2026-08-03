import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { accessibleOrgIds, orgFilter, orgLabels } from "../scope";

export function registerListApps(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_list_apps",
    "List all apps in the organization. Returns app name, status, deploy type, project, and latest deployment info. A cross-org token lists apps across every organization its user belongs to, each labeled with the organization it lives in.",
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
      const orgIds = await accessibleOrgIds(context);

      const appList = await db.query.apps.findMany({
        where: orgFilter(apps.organizationId, orgIds),
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
          organizationId: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [desc(apps.createdAt)],
        limit,
        offset,
      });

      // Single-org tokens see the shape they always have; aggregated results
      // are labeled, because an unlabeled cross-org list is ambiguous.
      const labels = context.crossOrg ? await orgLabels(orgIds) : null;
      const result = appList.map(({ organizationId, ...app }) =>
        labels ? { ...app, organization: labels.get(organizationId) ?? { id: organizationId } } : app
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ apps: result, count: result.length }, null, 2),
          },
        ],
      };
    }
  );
}
