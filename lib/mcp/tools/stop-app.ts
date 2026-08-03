import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { stopProject } from "@/lib/docker/deploy";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import { systemManagedRefusal } from "@/lib/api/system-managed";
import { recordLifecycle } from "@/lib/activity/lifecycle";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

// 10 stops per 10 minutes per user/org pair.
const STOP_RATE_LIMIT = 10;
const STOP_RATE_WINDOW_MS = 10 * 60 * 1000;

export function registerStopApp(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_stop_app",
    "Stop all containers for an app. The app will be offline until restarted or redeployed.",
    {
      appId: z.string().describe("The app ID to stop"),
    },
    async ({ appId }) => {
      const rl = await slidingWindowRateLimit(
        `${context.userId}:${context.organizationId}`,
        "mcp:stop-app",
        STOP_RATE_LIMIT,
        STOP_RATE_WINDOW_MS
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
          organizationId: true,
          isSystemManaged: true,
          parentAppId: true,
          composeService: true,
        },
      });

      if (!app || !(await canAccessOrg(context, app.organizationId))) {
        return accessDenied("App");
      }

      const refused = systemManagedRefusal(app, "stop");
      if (refused) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: refused }) }],
          isError: true,
        };
      }

      const startedAt = Date.now();
      const result = await stopProject(appId, app.name);

      if (result.success) {
        await recordLifecycle({
          organizationId: app.organizationId,
          app,
          kind: "stopped",
          userId: context.userId,
          trigger: "mcp",
          durationMs: Date.now() - startedAt,
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { appId, appName: app.name, ...result },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
