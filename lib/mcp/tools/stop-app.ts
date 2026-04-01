import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { stopProject } from "@/lib/docker/deploy";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import type { McpAuthContext } from "../auth";

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

      const result = await stopProject(appId, app.name);

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
