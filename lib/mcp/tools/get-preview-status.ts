import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { environments, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { resolveOrgPreview, previewNotFound } from "./preview-helpers";

export function registerGetPreviewStatus(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_get_preview_status",
    "Get the status of a preview environment. Returns the deployment status for each app in the preview, along with their URLs.",
    {
      preview_id: z
        .string()
        .describe("The preview environment ID (returned by vardo_create_preview)"),
    },
    async ({ preview_id }) => {
      const preview = await resolveOrgPreview(preview_id, context.organizationId);
      if (!preview) return previewNotFound();

      // Load environments for this preview with their app status
      const envs = await db
        .select({
          environmentId: environments.id,
          environmentName: environments.name,
          domain: environments.domain,
          gitBranch: environments.gitBranch,
          appId: apps.id,
          appName: apps.name,
          appDisplayName: apps.displayName,
          appStatus: apps.status,
        })
        .from(environments)
        .innerJoin(apps, eq(environments.appId, apps.id))
        .where(
          and(
            eq(environments.groupEnvironmentId, preview_id),
            eq(apps.organizationId, context.organizationId)
          )
        );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                preview: {
                  id: preview.id,
                  name: preview.name,
                  prNumber: preview.prNumber,
                  prUrl: preview.prUrl,
                  expiresAt: preview.expiresAt,
                  createdAt: preview.createdAt,
                },
                environments: envs,
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
