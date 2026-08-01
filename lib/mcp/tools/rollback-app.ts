import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps, deployments, environments, memberships } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createDeployment } from "@/lib/docker/deploy";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import { isOrgAdmin } from "@/lib/auth/permissions";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
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

      // Local environments don't support rollback — no blue-green slots to swap
      const defaultEnv = await db.query.environments.findFirst({
        where: and(
          eq(environments.appId, appId),
          eq(environments.isDefault, true),
        ),
        columns: { type: true },
      });
      if (defaultEnv?.type === "local") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Rollback is not supported for local environments",
              }),
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
        columns: { id: true, status: true, gitSha: true, gitMessage: true, configSnapshot: true },
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

      const configSnapshot = targetDeployment.configSnapshot as ConfigSnapshot | null;

      // The snapshot now drives the deploy, so restoring GPU passthrough here
      // grants host hardware access — gate it like enabling GPU directly.
      if (configSnapshot?.gpuEnabled === true) {
        const membership = await db.query.memberships.findFirst({
          where: and(
            eq(memberships.userId, context.userId),
            eq(memberships.organizationId, context.organizationId),
          ),
          columns: { role: true },
        });
        if (!membership || !isOrgAdmin(membership.role)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Only owners and admins can roll back to a snapshot with GPU passthrough enabled",
                }),
              },
            ],
            isError: true,
          };
        }
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
        rollback: { targetDeploymentId: deploymentId, includeEnvVars },
      }).then(async (result) => {
        // Tag the new deployment with rollback source
        try {
          await db
            .update(deployments)
            .set({ rollbackFromId: deploymentId })
            .where(eq(deployments.id, newDeploymentId));
        } catch { /* best-effort */ }

        // The deploy already ran on the snapshot — write the app record only
        // once it succeeded, so a failed rollback leaves the row untouched.
        if (!result.success) return;

        const appUpdates: Record<string, unknown> = { updatedAt: new Date() };

        if (configSnapshot) {
          appUpdates.cpuLimit = configSnapshot.cpuLimit;
          appUpdates.memoryLimit = configSnapshot.memoryLimit;
          appUpdates.gpuEnabled = configSnapshot.gpuEnabled ?? false;
          appUpdates.containerPort = configSnapshot.containerPort;
          appUpdates.imageName = configSnapshot.imageName;
          appUpdates.gitBranch = configSnapshot.gitBranch;
          appUpdates.composeFilePath = configSnapshot.composeFilePath;
          appUpdates.rootDirectory = configSnapshot.rootDirectory;
          appUpdates.restartPolicy = configSnapshot.restartPolicy;
          appUpdates.autoTraefikLabels = configSnapshot.autoTraefikLabels;
          appUpdates.backendProtocol = configSnapshot.backendProtocol ?? null;
          if (configSnapshot.composeContent != null) {
            appUpdates.composeContent = configSnapshot.composeContent;
          }
        }

        if (includeEnvVars) {
          try {
            const target = await db.query.deployments.findFirst({
              where: eq(deployments.id, deploymentId),
              columns: { envSnapshot: true },
            });
            if (target?.envSnapshot) {
              const { decrypt, encrypt } = await import("@/lib/crypto/encrypt");
              const plainEnv = decrypt(target.envSnapshot, context.organizationId);
              appUpdates.envContent = encrypt(plainEnv, context.organizationId);
            }
          } catch { /* env restore is best-effort */ }
        }

        await db.update(apps).set(appUpdates).where(eq(apps.id, appId)).catch(() => {});
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
