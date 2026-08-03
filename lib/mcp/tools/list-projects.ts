import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { accessibleOrgIds, orgFilter, orgLabels } from "../scope";

export function registerListProjects(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_list_projects",
    "List all projects in the organization. Projects group related apps together. Returns project name, description, color, and the apps within each project. A cross-org token lists projects across every organization its user belongs to, each labeled with the organization it lives in.",
    {},
    async () => {
      const orgIds = await accessibleOrgIds(context);

      const projectList = await db.query.projects.findMany({
        where: orgFilter(projects.organizationId, orgIds),
        with: {
          apps: {
            columns: { id: true, name: true, displayName: true, status: true },
          },
        },
        orderBy: [desc(projects.createdAt)],
      });

      const labels = context.crossOrg ? await orgLabels(orgIds) : null;
      const result = labels
        ? projectList.map((p) => ({
            ...p,
            organization: labels.get(p.organizationId) ?? { id: p.organizationId },
          }))
        : projectList;

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
