import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { groupEnvironments, environments, apps, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { previewNotFound } from "./preview-helpers";

export function registerGetPreviewUrl(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_get_preview_url",
    "Get the URLs for a preview environment. Returns all domain URLs for each app in the preview.",
    {
      preview_id: z
        .string()
        .describe("The preview environment ID (returned by vardo_create_preview)"),
    },
    async ({ preview_id }) => {
      // Single query: verify org ownership and fetch environment URLs in one JOIN.
      // LEFT JOINs on environments/apps so a preview with no environments still
      // resolves rather than returning not-found.
      const rows = await db
        .select({
          envId: environments.id,
          envName: environments.name,
          domain: environments.domain,
          appId: apps.id,
          appName: apps.name,
          appDisplayName: apps.displayName,
        })
        .from(groupEnvironments)
        .innerJoin(projects, eq(groupEnvironments.projectId, projects.id))
        .leftJoin(
          environments,
          eq(environments.groupEnvironmentId, groupEnvironments.id)
        )
        .leftJoin(apps, eq(environments.appId, apps.id))
        .where(
          and(
            eq(groupEnvironments.id, preview_id),
            eq(projects.organizationId, context.organizationId)
          )
        );

      if (rows.length === 0) return previewNotFound();

      const urls = rows
        .filter((r) => r.envId != null && r.domain != null)
        .map((r) => ({
          appId: r.appId!,
          appName: r.appName!,
          appDisplayName: r.appDisplayName,
          url: `https://${r.domain}`,
          domain: r.domain,
        }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ previewId: preview_id, urls }, null, 2),
          },
        ],
      };
    }
  );
}
