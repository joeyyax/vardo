import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createDeployment } from "@/lib/docker/deploy";
import { startOrRestartApp } from "@/lib/docker/start-app";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

// 10 restarts per 10 minutes per user/org pair.
const RESTART_RATE_LIMIT = 10;
const RESTART_RATE_WINDOW_MS = 10 * 60 * 1000;

export function registerRestartApp(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_restart_app",
    "Restart all containers for an app. A running app gets a graceful in-place restart. A stopped one is brought back up from the deployment already on disk — same images, no rebuild. A compose child restarts or starts only its own service inside the parent's project. When nothing is on disk to bring up, this falls through to a deploy of the app (or of the parent, for a compose child) and returns deploymentId; poll it with vardo_get_deploy_status.",
    {
      appId: z.string().describe("The app ID to restart"),
    },
    async ({ appId }) => {
      const rl = await slidingWindowRateLimit(
        `${context.userId}:${context.organizationId}`,
        "mcp:restart-app",
        RESTART_RATE_LIMIT,
        RESTART_RATE_WINDOW_MS
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
        where: eq(apps.id, appId),
        columns: {
          id: true,
          name: true,
          status: true,
          organizationId: true,
          parentAppId: true,
          composeService: true,
        },
      });

      if (!app || !(await canAccessOrg(context, app.organizationId))) {
        return accessDenied("App");
      }

      const result = await startOrRestartApp({
        organizationId: app.organizationId,
        app,
        userId: context.userId,
        trigger: "mcp",
      });

      // Nothing on disk to bring up, so a deploy is the only thing that can
      // produce containers. It records itself as a deploy, not as a start.
      if (result.failure === "no-slot") {
        const deployTargetId = app.parentAppId ?? app.id;

        const deploymentId = await createDeployment({
          appId: deployTargetId,
          organizationId: app.organizationId,
          trigger: "api",
          triggeredBy: context.userId,
        });

        // Fire the deploy in the background — return the ID immediately so the
        // caller polls vardo_get_deploy_status, matching vardo_deploy_app.
        const { requestDeploy } = await import("@/lib/docker/deploy-cancel");
        requestDeploy({
          appId: deployTargetId,
          organizationId: app.organizationId,
          trigger: "api",
          triggeredBy: context.userId,
          deploymentId,
        }).catch(() => {
          // Failures are recorded on the deployment record — poll to observe.
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  appId,
                  appName: app.name,
                  action: "deployed",
                  deployTargetId,
                  deployedParent: app.parentAppId !== null,
                  deploymentId,
                  status: "queued",
                  message:
                    app.parentAppId !== null
                      ? "Nothing deployed on disk — triggered a deploy of the parent compose app. Use vardo_get_deploy_status to poll."
                      : "Nothing deployed on disk — triggered a deploy to bring the app up. Use vardo_get_deploy_status to poll.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (!result.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { appId, appName: app.name, action: result.action, error: result.log },
                null,
                2
              ),
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
              {
                appId,
                appName: app.name,
                action: result.action,
                status: result.observed,
                log: result.log,
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
