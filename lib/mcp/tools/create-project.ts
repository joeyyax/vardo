import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import type { McpAuthContext } from "../auth";

export function registerCreateProject(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_create_project",
    "Create a new project to group related apps together.",
    {
      name: z.string().min(1).max(100).describe("Project slug (lowercase, hyphens)"),
      displayName: z.string().min(1).max(100).describe("Human-readable project name"),
      description: z.string().max(500).nullable().optional().describe("Optional description"),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Hex color (default #6366f1)"),
    },
    async ({ name, displayName, description, color }) => {
      const [project] = await db
        .insert(projects)
        .values({
          id: nanoid(),
          organizationId: context.organizationId,
          name,
          displayName,
          description: description ?? null,
          color: color ?? "#6366f1",
        })
        .returning();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ project }, null, 2),
          },
        ],
      };
    }
  );
}
