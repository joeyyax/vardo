import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listApps } from "@/lib/app-services/apps";
import type { McpAuthContext } from "../auth";
import { accessibleActors } from "../actors";

export function registerListApps(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_list_apps",
    "List all apps in the organization. Returns app name, status, why a down app exited, deploy type, project, and latest deployment info. A cross-org token lists apps across every organization its user belongs to, each labeled with the organization it lives in.",
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
      const actors = await accessibleActors(context, "app.view");

      // One org pages in SQL. Several merge each org's first offset + limit by age, then page.
      const single = actors.length === 1;
      const perOrg = await Promise.all(
        actors.map(async (actor) => {
          const page = await listApps(actor, single ? { limit, offset } : { limit: offset + limit, offset: 0 });
          const label = { id: actor.org.id, name: actor.org.name, slug: actor.org.slug };
          return page.apps.map((app) => ({ app, label }));
        }),
      );
      const rows = single
        ? perOrg.flat()
        : perOrg
            .flat()
            .sort((a, b) => b.app.createdAt.getTime() - a.app.createdAt.getTime())
            .slice(offset, offset + limit);

      const result = rows.map(({ app, label }) => {
        const summary = {
          id: app.id,
          name: app.name,
          displayName: app.displayName,
          status: app.status,
          exitReason: app.exitReason,
          deployType: app.deployType,
          source: app.source,
          createdAt: app.createdAt,
          updatedAt: app.updatedAt,
          deployments: app.deployments,
          project: app.project
            ? { id: app.project.id, name: app.project.name, displayName: app.project.displayName }
            : null,
        };
        // Cross-org results are labeled with their org.
        return context.crossOrg ? { ...summary, organization: label } : summary;
      });

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
