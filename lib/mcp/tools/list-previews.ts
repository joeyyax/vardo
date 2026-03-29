import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { groupEnvironments, projects } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { McpAuthContext } from "../auth";

export function registerListPreviews(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_list_previews",
    "List all active preview environments in the organization. Returns the preview ID, name, PR number, expiry time, and associated domains.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe("Max previews to return (1-100, default 50)"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Offset for pagination"),
    },
    async ({ limit, offset }) => {
      const rows = await db
        .select({
          id: groupEnvironments.id,
          name: groupEnvironments.name,
          prNumber: groupEnvironments.prNumber,
          prUrl: groupEnvironments.prUrl,
          createdAt: groupEnvironments.createdAt,
          expiresAt: groupEnvironments.expiresAt,
          projectId: groupEnvironments.projectId,
        })
        .from(groupEnvironments)
        .innerJoin(projects, eq(groupEnvironments.projectId, projects.id))
        .where(
          and(
            eq(groupEnvironments.type, "preview"),
            eq(projects.organizationId, context.organizationId)
          )
        )
        .orderBy(desc(groupEnvironments.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ previews: rows, count: rows.length }, null, 2),
          },
        ],
      };
    }
  );
}
