import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createDeployment } from "@/lib/docker/deploy";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

// Coarse abuse ceiling: 60 deploys per minute per user/org pair.
// Bursts are never rejected as a cooldown — requestDeploy serializes rapid
// deploys via per-app cancel-and-replace (latest commit wins) and the
// system-level FIFO concurrency queue (#682). This limit only stops a runaway
// loop from creating unbounded deployment records.
const DEPLOY_RATE_LIMIT = 60;
const DEPLOY_RATE_WINDOW_MS = 60 * 1000;

export function registerDeployApp(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_deploy_app",
    "Trigger a deployment for an app. The API endpoint returns an SSE stream, so this tool starts the deploy asynchronously and returns the deploymentId for polling with vardo_get_deploy_status. Does not block waiting for completion.",
    {
      appId: z.string().describe("The app ID to deploy"),
      environmentId: z
        .string()
        .optional()
        .describe("Optional environment ID to deploy to (defaults to production)"),
    },
    async ({ appId, environmentId }) => {
      const rl = await slidingWindowRateLimit(
        `${context.userId}:${context.organizationId}`,
        "mcp:deploy-app",
        DEPLOY_RATE_LIMIT,
        DEPLOY_RATE_WINDOW_MS
      );
      if (rl.limited) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Deploy rate ceiling reached (abuse protection, 60/min). Try again in ${rl.retryAfterSeconds}s.`,
              }),
            },
          ],
          isError: true,
        };
      }

      const app = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
        columns: { id: true, name: true, organizationId: true },
      });

      if (!app || !(await canAccessOrg(context, app.organizationId))) {
        return accessDenied("App");
      }

      // Create the deployment record. The deploy worker picks it up
      // asynchronously — we return the ID immediately for polling.
      const deploymentId = await createDeployment({
        appId,
        organizationId: app.organizationId,
        trigger: "api",
        triggeredBy: context.userId,
        environmentId,
      });

      // Fire the actual deploy in the background. Import requestDeploy
      // to handle cancel-and-replace semantics.
      const { requestDeploy } = await import("@/lib/docker/deploy-cancel");
      requestDeploy({
        appId,
        organizationId: app.organizationId,
        trigger: "api",
        triggeredBy: context.userId,
        deploymentId,
        environmentId,
      }).catch(() => {
        // Deploy failures are recorded on the deployment record — the
        // caller polls vardo_get_deploy_status to observe them.
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                deploymentId,
                appId,
                appName: app.name,
                status: "queued",
                message: "Deploy started. Use vardo_get_deploy_status to poll for progress.",
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
