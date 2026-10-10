import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listProjects } from "@/lib/app-services/projects";
import type { McpAuthContext } from "../auth";
import { accessibleActors } from "../actors";

export function registerListProjects(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_list_projects",
    "List all projects in the organization. Projects group related apps together. Returns project name, description, color, and the apps within each project. A cross-org token lists projects across every organization its user belongs to, each labeled with the organization it lives in.",
    {},
    async () => {
      const actors = await accessibleActors(context, "org.view");
      const perOrg = await Promise.all(
        actors.map(async (actor) => {
          const projects = await listProjects(actor);
          // Cross-org results are labeled with their org.
          const label = { id: actor.org.id, name: actor.org.name, slug: actor.org.slug };
          return context.crossOrg ? projects.map((p) => ({ ...p, organization: label })) : projects;
        }),
      );
      const result = perOrg.flat().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { projects: result, count: result.length },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
