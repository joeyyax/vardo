import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { restartContainers } from "@/lib/docker/deploy";
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
    "Restart all containers for an app. Does a graceful restart without rebuilding — useful after config changes or to recover from a stuck state.",
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

      const result = await restartContainers(app.name);

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
