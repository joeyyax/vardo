import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { groupEnvironments, projects, environments } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { McpAuthContext } from "../auth";

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

      const envs = await db.query.environments.findMany({
        where: eq(environments.groupEnvironmentId, preview_id),
        columns: { id: true, name: true, domain: true },
        with: {
          app: { columns: { id: true, name: true, displayName: true } },
        },
      });

      const urls = envs
        .filter((e) => e.domain)
        .map((e) => ({
          appId: e.app.id,
          appName: e.app.name,
          appDisplayName: e.app.displayName,
          url: `https://${e.domain}`,
          domain: e.domain,
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
