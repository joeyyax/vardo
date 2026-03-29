import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { destroyGroupEnvironment } from "@/lib/docker/clone";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import type { McpAuthContext } from "../auth";
import { resolveOrgPreview, previewNotFound } from "./preview-helpers";

// 10 destroys per 10 minutes per user/org pair.
// destroyGroupEnvironment does real Docker work (container teardown, network
// cleanup) — rate-limiting prevents hammering the daemon in a create/destroy loop.
const DESTROY_RATE_LIMIT = 10;
const DESTROY_RATE_WINDOW_MS = 10 * 60 * 1000;

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
      const rl = await slidingWindowRateLimit(
        `${context.userId}:${context.organizationId}`,
        "mcp:destroy-preview",
        DESTROY_RATE_LIMIT,
        DESTROY_RATE_WINDOW_MS
      );
      if (rl.limited) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Rate limit exceeded. Try again in ${rl.retryAfterSeconds}s.`,
              }),
            },
          ],
          isError: true,
        };
      }

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
