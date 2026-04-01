import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import type { McpAuthContext } from "../auth";

// 10 updates per 5 minutes per user/org pair.
const UPDATE_RATE_LIMIT = 10;
const UPDATE_RATE_WINDOW_MS = 5 * 60 * 1000;

const updateSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
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
    "Update configuration for a specific app. Pass any subset of fields to update: displayName, description, containerPort, gitBranch, deployType, resource limits, etc. Does not trigger a deploy — use vardo_deploy_app after updating if needed.",
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

      // Verify app exists, belongs to org, and is not system-managed
      const existingApp = await db.query.apps.findFirst({
        where: and(eq(apps.id, appId), eq(apps.organizationId, context.organizationId)),
        columns: { id: true },
      });

      if (!existingApp) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "App not found or access denied" }),
            },
          ],
          isError: true,
        };
      }

      const [updated] = await db
        .update(apps)
        .set({ ...config, updatedAt: new Date() })
        .where(
          and(eq(apps.id, appId), eq(apps.organizationId, context.organizationId))
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
