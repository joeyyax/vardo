import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import type { McpAuthContext } from "../auth";
import { resolveTargetOrg } from "../scope";

export function registerCreateProject(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_create_project",
    "Create a new project to group related apps together. Defaults to the token's own organization; a cross-org token can pass organizationId to create the project in another organization its user belongs to.",
    {
      name: z.string().min(1).max(100).describe("Project slug (lowercase, hyphens)"),
      displayName: z.string().min(1).max(100).describe("Human-readable project name"),
      description: z.string().max(500).nullable().optional().describe("Optional description"),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Hex color (default #6366f1)"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization to create the project in (default: the token's own organization)"
        ),
    },
    async ({ name, displayName, description, color, organizationId }) => {
      // Membership-checked; a caller-supplied org id is never taken on trust.
      const orgId = await resolveTargetOrg(context, organizationId);
      if (!orgId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Organization not found or access denied" }),
            },
          ],
          isError: true,
        };
      }

      const [project] = await db
        .insert(projects)
        .values({
          id: nanoid(),
          organizationId: orgId,
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
