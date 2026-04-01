import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createDeployment } from "@/lib/docker/deploy";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import type { McpAuthContext } from "../auth";

// 3 rollbacks per 10 minutes per user/org pair.
const ROLLBACK_RATE_LIMIT = 3;
const ROLLBACK_RATE_WINDOW_MS = 10 * 60 * 1000;

export function registerRollbackApp(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_rollback_app",
    "Roll back an app to a previous successful deployment. Triggers a new deploy using the config and code from the target deployment. Returns the new deploymentId for polling with vardo_get_deploy_status.",
    {
      appId: z.string().describe("The app ID to roll back"),
      deploymentId: z
        .string()
        .describe("The deployment ID to roll back to (must be a successful deployment)"),
      includeEnvVars: z
        .boolean()
        .default(false)
        .describe("Whether to also restore the env vars from the target deployment (default false)"),
    },
    async ({ appId, deploymentId, includeEnvVars }) => {
      const rl = await slidingWindowRateLimit(
        `${context.userId}:${context.organizationId}`,
        "mcp:rollback-app",
        ROLLBACK_RATE_LIMIT,
        ROLLBACK_RATE_WINDOW_MS
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

      const app = await db.query.apps.findFirst({
        where: and(
          eq(apps.id, appId),
          eq(apps.organizationId, context.organizationId)
        ),
        columns: { id: true, name: true },
      });

      if (!app) {
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

      // Verify the target deployment exists, belongs to this app, and was successful
      const targetDeployment = await db.query.deployments.findFirst({
        where: and(
          eq(deployments.id, deploymentId),
          eq(deployments.appId, appId)
        ),
        columns: { id: true, status: true, gitSha: true, gitMessage: true },
      });

      if (!targetDeployment) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Target deployment not found" }),
            },
          ],
          isError: true,
        };
      }

      if (targetDeployment.status !== "success") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Can only roll back to a successful deployment" }),
            },
          ],
          isError: true,
        };
      }

      // Create the rollback deployment record and fire it asynchronously
      const newDeploymentId = await createDeployment({
        appId,
        organizationId: context.organizationId,
        trigger: "rollback",
        triggeredBy: context.userId,
      });

      const { requestDeploy } = await import("@/lib/docker/deploy-cancel");
      requestDeploy({
        appId,
        organizationId: context.organizationId,
        trigger: "rollback",
        triggeredBy: context.userId,
        deploymentId: newDeploymentId,
      }).then(async (result) => {
        // Tag the new deployment with rollback source
        try {
          await db
            .update(deployments)
            .set({ rollbackFromId: deploymentId })
            .where(eq(deployments.id, newDeploymentId));
        } catch { /* best-effort */ }

        // Apply env restore after successful deploy
        if (result.success && includeEnvVars) {
          try {
            const target = await db.query.deployments.findFirst({
              where: eq(deployments.id, deploymentId),
              columns: { envSnapshot: true },
            });
            if (target?.envSnapshot) {
              const { decrypt, encrypt } = await import("@/lib/crypto/encrypt");
              const plainEnv = decrypt(target.envSnapshot, context.organizationId);
              const encrypted = encrypt(plainEnv, context.organizationId);
              await db.update(apps).set({ envContent: encrypted }).where(eq(apps.id, appId));
            }
          } catch { /* env restore is best-effort */ }
        }
      }).catch(() => {
        // Failures recorded on the deployment record
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                deploymentId: newDeploymentId,
                appId,
                appName: app.name,
                rollingBackTo: {
                  deploymentId: targetDeployment.id,
                  gitSha: targetDeployment.gitSha,
                  gitMessage: targetDeployment.gitMessage,
                },
                includeEnvVars,
                status: "queued",
                message: "Rollback deploy started. Use vardo_get_deploy_status to poll for progress.",
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
