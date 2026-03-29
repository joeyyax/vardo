import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { destroyGroupEnvironment } from "@/lib/docker/clone";
import type { McpAuthContext } from "../auth";
import { resolveOrgPreview, previewNotFound } from "./preview-helpers";

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
      const preview = await resolveOrgPreview(preview_id, context.organizationId);
      if (!preview) return previewNotFound();

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
