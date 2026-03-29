import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { groupEnvironments, environments, apps, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { McpAuthContext } from "../auth";
import { previewNotFound } from "./preview-helpers";

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
      // Single query: verify org ownership and fetch environments in one JOIN.
      // groupEnvironments → projects (org check) → environments → apps.
      // LEFT JOINs on environments/apps so a preview with no environments still
      // returns the preview metadata rather than an empty result set.
      const rows = await db
        .select({
          previewId: groupEnvironments.id,
          previewName: groupEnvironments.name,
          prNumber: groupEnvironments.prNumber,
          prUrl: groupEnvironments.prUrl,
          expiresAt: groupEnvironments.expiresAt,
          previewCreatedAt: groupEnvironments.createdAt,
          environmentId: environments.id,
          environmentName: environments.name,
          domain: environments.domain,
          gitBranch: environments.gitBranch,
          appId: apps.id,
          appName: apps.name,
          appDisplayName: apps.displayName,
          appStatus: apps.status,
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

      const first = rows[0];
      const preview = {
        id: first.previewId,
        name: first.previewName,
        prNumber: first.prNumber,
        prUrl: first.prUrl,
        expiresAt: first.expiresAt,
        createdAt: first.previewCreatedAt,
      };

      const envs = rows
        .filter((r) => r.environmentId != null)
        .map((r) => ({
          environmentId: r.environmentId!,
          environmentName: r.environmentName!,
          domain: r.domain,
          gitBranch: r.gitBranch,
          appId: r.appId!,
          appName: r.appName!,
          appDisplayName: r.appDisplayName,
          appStatus: r.appStatus!,
        }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ preview, environments: envs }, null, 2),
          },
        ],
      };
    }
  );
}
