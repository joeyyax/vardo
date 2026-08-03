import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import { systemManagedRefusal } from "@/lib/api/system-managed";
import { sharedMarkerTypeErrors } from "@/lib/docker/compose";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

// 10 updates per 5 minutes per user/org pair.
const UPDATE_RATE_LIMIT = 10;
const UPDATE_RATE_WINDOW_MS = 5 * 60 * 1000;

const updateSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  projectId: z.string().min(1).optional(),
  containerPort: z.number().int().positive().nullable().optional(),
  autoTraefikLabels: z.boolean().optional(),
  autoDeploy: z.boolean().optional(),
  gitBranch: z.string().nullable().optional(),
  rootDirectory: z.string().nullable().optional(),
  source: z.enum(["git", "direct"]).optional(),
  deployType: z.enum(["compose", "dockerfile", "image", "static", "nixpacks", "railpack"]).optional(),
  composeContent: z.string().max(512000).nullable().optional(),
  composeFilePath: z.string().nullable().optional(),
  dockerfilePath: z.string().nullable().optional(),
  gitUrl: z.string().nullable().optional(),
  imageName: z.string().nullable().optional(),
  restartPolicy: z.string().nullable().optional(),
  cpuLimit: z.number().positive().max(64).nullable().optional(),
  memoryLimit: z.number().int().min(64).max(65536).nullable().optional(),
  priority: z.enum(["critical", "standard", "disposable"]).nullable().optional(), // null = inherit parent (decomposed child)
  backendProtocol: z.enum(["http", "https"]).nullable().optional(),
  healthCheckTimeout: z.number().int().min(10).max(600).nullable().optional(),
  autoRollback: z.boolean().optional(),
  rollbackGracePeriod: z.number().int().min(10).max(600).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).strict();

export function registerUpdateApp(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_update_app",
    "Update configuration for a specific app. Pass any subset of fields to update: displayName, description, projectId, containerPort, gitBranch, deployType, resource limits, etc. Does not trigger a deploy — use vardo_deploy_app after updating if needed.",
    {
      appId: z.string().describe("The app ID to update"),
      config: updateSchema.describe("Partial config object with fields to update"),
    },
    async ({ appId, config }) => {
      const rl = await slidingWindowRateLimit(
        `${context.userId}:${context.organizationId}`,
        "mcp:update-app",
        UPDATE_RATE_LIMIT,
        UPDATE_RATE_WINDOW_MS
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

      const existingApp = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
        columns: {
          id: true,
          name: true,
          organizationId: true,
          isSystemManaged: true,
        },
      });

      if (!existingApp || !(await canAccessOrg(context, existingApp.organizationId))) {
        return accessDenied("App");
      }

      // Refiling an app into a foreign project would hand it that project's
      // bind-mount and docker-socket privileges on the next deploy.
      if (config.projectId) {
        const project = await db.query.projects.findFirst({
          where: and(
            eq(projects.id, config.projectId),
            eq(projects.organizationId, existingApp.organizationId)
          ),
          columns: { id: true },
        });
        if (!project) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Project not found in this app's organization" }),
              },
            ],
            isError: true,
          };
        }
      }

      const refused = systemManagedRefusal(existingApp, "edit");
      if (refused) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: refused }) }],
          isError: true,
        };
      }

      // The marker only survives as a boolean; a quoted one is dropped by the
      // parser at deploy time and the service gets blue/green'd.
      const markerErrors = config.composeContent
        ? sharedMarkerTypeErrors(config.composeContent)
        : [];
      if (markerErrors.length > 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: markerErrors.join("\n") }) }],
          isError: true,
        };
      }

      const [updated] = await db
        .update(apps)
        .set({ ...config, updatedAt: new Date() })
        .where(
          and(eq(apps.id, appId), eq(apps.organizationId, existingApp.organizationId))
        )
        .returning();

      if (!updated) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Update failed" }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { app: updated, updatedFields: Object.keys(config) },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
