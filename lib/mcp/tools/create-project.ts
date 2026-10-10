import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createProject } from "@/lib/app-services/projects";
import { mcpActor } from "@/lib/app-services/mcp-actor";
import type { McpAuthContext } from "../auth";
import { serviceErrorResult } from "../actors";
import { accessDenied } from "../scope";

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
      const actor = await mcpActor(context, organizationId || context.organizationId, "project.manage");
      if (!actor) return accessDenied("Organization");

      try {
        const project = await createProject(actor, { name, displayName, description, color });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ project }, null, 2),
            },
          ],
        };
      } catch (error) {
        return serviceErrorResult(error, "Organization");
      }
    }
  );
}
