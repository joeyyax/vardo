import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { encrypt } from "@/lib/crypto/encrypt";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import type { McpAuthContext } from "../auth";

// 10 env updates per 5 minutes per user/org pair.
const ENV_RATE_LIMIT = 10;
const ENV_RATE_WINDOW_MS = 5 * 60 * 1000;

export function registerSetEnvVars(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_set_env_vars",
    "Set the environment variables for an app. Takes the full env file content as a string (KEY=VALUE format, one per line). Overwrites all existing env vars. Sets needsRedeploy flag — use vardo_deploy_app after to apply changes.",
    {
      appId: z.string().describe("The app ID to set env vars for"),
      content: z.string().describe("Full env file content (KEY=VALUE per line)"),
    },
    async ({ appId, content }) => {
      const rl = await slidingWindowRateLimit(
        `${context.userId}:${context.organizationId}`,
        "mcp:set-env-vars",
        ENV_RATE_LIMIT,
        ENV_RATE_WINDOW_MS
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
        columns: { id: true },
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

      const encrypted = content.trim() ? encrypt(content, context.organizationId) : null;

      await db
        .update(apps)
        .set({
          envContent: encrypted,
          needsRedeploy: true,
          updatedAt: new Date(),
        })
        .where(and(eq(apps.id, appId), eq(apps.organizationId, context.organizationId)));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ saved: true, needsRedeploy: true }, null, 2),
          },
        ],
      };
    }
  );
}
