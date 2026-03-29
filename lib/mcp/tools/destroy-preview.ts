import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { groupEnvironments, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { destroyGroupEnvironment } from "@/lib/docker/clone";
import type { McpAuthContext } from "../auth";

export function registerDestroyPreview(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_destroy_preview",
    "Tear down a preview environment and remove all its containers and resources. Use after a PR is merged or closed.",
    {
      preview_id: z
        .string()
        .describe("The preview environment ID (returned by vardo_create_preview)"),
    },
    async ({ preview_id }) => {
      // Verify the preview belongs to this org
      const preview = await db
        .select({
          id: groupEnvironments.id,
          name: groupEnvironments.name,
          organizationId: projects.organizationId,
        })
        .from(groupEnvironments)
        .innerJoin(projects, eq(groupEnvironments.projectId, projects.id))
        .where(eq(groupEnvironments.id, preview_id))
        .then((rows) => rows[0] ?? null);

      if (!preview || preview.organizationId !== context.organizationId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Preview not found or access denied" }),
            },
          ],
          isError: true,
        };
      }

      const result = await destroyGroupEnvironment(
        preview_id,
        context.organizationId
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                destroyed: true,
                previewId: preview_id,
                previewName: preview.name,
                removed: result.removed,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
