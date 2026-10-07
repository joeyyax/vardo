import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteApp } from "@/lib/docker/delete-app";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import { isOrgAdmin } from "@/lib/auth/permissions";
import type { McpAuthContext } from "../auth";
import { accessDenied, orgRole, resolveAppOrg } from "../scope";

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
    "Delete an app: tears down its containers, removes its deployment directory and the app record (and its compose child records when deleting a parent). Volumes and bind-mounted data inside the app directory are KEPT by default. Set deleteVolumes=true to destroy them too; pass keepVolumes to protect specific volumes. A volume still in use by a running container is left in place.",
    {
      appId: z.string().describe("The app ID to delete"),
      deleteVolumes: z
        .boolean()
        .default(false)
        .describe(
          "When true, also destroy the app's volumes and bind-mounted data. Default false keeps them."
        ),
      keepVolumes: z
        .array(z.string())
        .default([])
        .describe(
          "Volumes to keep even when deleteVolumes is true. Matches the full Docker volume name (e.g. 'agents-production_claude-auth') or the compose-stripped suffix (e.g. 'claude-auth')."
        ),
    },
    async ({ appId, deleteVolumes, keepVolumes }) => {
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

      const orgId = await resolveAppOrg(context, appId);
      if (!orgId) return accessDenied("App");

      // The role held in the app's own org, never the token's home org.
      const role = await orgRole(context, orgId);
      if (!role || !isOrgAdmin(role)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Only owners and admins can delete apps" }),
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await deleteApp({
          appId,
          organizationId: orgId,
          userId: context.userId,
          deleteVolumes,
          keepVolumes,
          source: "mcp",
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
