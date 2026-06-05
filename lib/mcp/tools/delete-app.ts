import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteApp } from "@/lib/docker/delete-app";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import type { McpAuthContext } from "../auth";

// 5 deletes per 10 minutes per user/org pair.
// Deletion does real Docker teardown — rate-limit to avoid hammering the daemon.
const DELETE_RATE_LIMIT = 5;
const DELETE_RATE_WINDOW_MS = 10 * 60 * 1000;

export function registerDeleteApp(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_delete_app",
    "Delete a compose app: tears down its containers and removes the app record (and its compose child records when deleting a parent). Named volumes are PRESERVED by default. Set pruneVolumes=true to also remove the app's own declared volumes; pass keepVolumes to protect specific named volumes even when pruning. Volumes Vardo does not know the app declared (e.g. a separate OAuth/credential volume) are never touched. A volume still in use by a running container is left in place.",
    {
      appId: z.string().describe("The app ID to delete"),
      pruneVolumes: z
        .boolean()
        .default(false)
        .describe(
          "When true, also remove the app's own declared named volumes. Default false preserves all volumes."
        ),
      keepVolumes: z
        .array(z.string())
        .default([])
        .describe(
          "Named volumes to preserve even when pruneVolumes is true. Matches the full Docker volume name (e.g. 'agents_claude-auth') or the compose-stripped suffix (e.g. 'claude-auth')."
        ),
    },
    async ({ appId, pruneVolumes, keepVolumes }) => {
      const rl = await slidingWindowRateLimit(
        `${context.userId}:${context.organizationId}`,
        "mcp:delete-app",
        DELETE_RATE_LIMIT,
        DELETE_RATE_WINDOW_MS
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

      try {
        const result = await deleteApp({
          appId,
          organizationId: context.organizationId,
          userId: context.userId,
          pruneVolumes,
          keepVolumes,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
