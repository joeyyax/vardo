import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import type { McpAuthContext } from "../auth";

export function registerListProjects(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_list_projects",
    "List all projects in the organization. Projects group related apps together. Returns project name, description, color, and the apps within each project.",
    {},
    async () => {
      const projectList = await db.query.projects.findMany({
        where: eq(projects.organizationId, context.organizationId),
        with: {
          apps: {
            columns: { id: true, name: true, displayName: true, status: true },
          },
        },
        orderBy: [desc(projects.createdAt)],
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { projects: projectList, count: projectList.length },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
