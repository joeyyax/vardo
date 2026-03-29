import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { environments } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { resolveOrgPreview, previewNotFound } from "./preview-helpers";

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
      const preview = await resolveOrgPreview(preview_id, context.organizationId);
      if (!preview) return previewNotFound();

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
