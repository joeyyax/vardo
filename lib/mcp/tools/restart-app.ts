import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { restartContainers, createDeployment } from "@/lib/docker/deploy";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import type { McpAuthContext } from "../auth";

// 10 restarts per 10 minutes per user/org pair.
const RESTART_RATE_LIMIT = 10;
const RESTART_RATE_WINDOW_MS = 10 * 60 * 1000;

export function registerRestartApp(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_restart_app",
    "Restart all containers for an app. For a running app this does a graceful in-place restart without rebuilding. For an app that is stopped (or a decomposed compose child with no live containers) there is nothing to restart in place, so this transparently falls through to a deploy — which recreates the containers. When the target is a compose child, the deploy runs on its parent. Returns deploymentId when it falls through to a deploy; poll with vardo_get_deploy_status.",
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
        where: and(
          eq(apps.id, appId),
          eq(apps.organizationId, context.organizationId)
        ),
        columns: {
          id: true,
          name: true,
          status: true,
          parentAppId: true,
          composeService: true,
        },
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

      // An in-place `docker compose restart` only works when there are live
      // containers AND a slot directory to run it from. A stopped app has no
      // running containers (it was brought down with `compose down`, which
      // removes them) and may have no slot directory at all — `restartContainers`
      // would then spawn docker with a non-existent cwd and fail with the
      // misleading "spawn docker ENOENT". When the app is not active, fall
      // through to a deploy, which recreates the slot dir and brings containers
      // up. For a compose child, the deployable unit is the parent compose app.
      if (app.status !== "active") {
        const deployTargetId = app.parentAppId ?? app.id;

        const deploymentId = await createDeployment({
          appId: deployTargetId,
          organizationId: context.organizationId,
          trigger: "api",
          triggeredBy: context.userId,
        });

        // Fire the deploy in the background — return the ID immediately so the
        // caller polls vardo_get_deploy_status, matching vardo_deploy_app.
        const { requestDeploy } = await import("@/lib/docker/deploy-cancel");
        requestDeploy({
          appId: deployTargetId,
          organizationId: context.organizationId,
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
                  restartedInPlace: false,
                  fellThroughToDeploy: true,
                  deployTargetId,
                  deployedParent: app.parentAppId !== null,
                  deploymentId,
                  status: "queued",
                  message:
                    app.parentAppId !== null
                      ? "App is a compose child — restart triggered a deploy of its parent. Use vardo_get_deploy_status to poll."
                      : "App was not running — restart triggered a deploy to bring it up. Use vardo_get_deploy_status to poll.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Active app: restart in place. A decomposed child runs inside its
      // parent's compose project, so restart just that service from the parent's
      // slot directory rather than redeploying the whole stack.
      let result: { success: boolean; log: string };
      if (app.parentAppId) {
        const parent = await db.query.apps.findFirst({
          where: and(
            eq(apps.id, app.parentAppId),
            eq(apps.organizationId, context.organizationId)
          ),
          columns: { name: true },
        });
        if (!parent || !app.composeService) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Could not resolve parent compose project for this child app",
                }),
              },
            ],
            isError: true,
          };
        }
        result = await restartContainers(parent.name, undefined, app.composeService);
      } else {
        result = await restartContainers(app.name);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { appId, appName: app.name, restartedInPlace: true, ...result },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
