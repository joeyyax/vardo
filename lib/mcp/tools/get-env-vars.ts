import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { decryptOrFallback, encrypt } from "@/lib/crypto/encrypt";
import { systemManagedRefusal } from "@/lib/api/system-managed";
import { recordActivity } from "@/lib/activity";
import type { McpAuthContext } from "../auth";
import { accessDenied, canAccessOrg } from "../scope";

export function registerGetEnvVars(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_get_env_vars",
    "Get the decrypted environment variables for an app. Returns the full env file content as a string. Needs an org admin.",
    {
      appId: z.string().describe("The app ID to get env vars for"),
    },
    async ({ appId }) => {
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
        columns: {
          id: true,
          name: true,
          organizationId: true,
          isSystemManaged: true,
          envContent: true,
        },
      });

      if (!app || !(await canAccessOrg(context, app.organizationId, "env.reveal"))) {
        return accessDenied("App");
      }

      const refused = systemManagedRefusal(app, "env-vars");
      if (refused) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: refused }) }],
          isError: true,
        };
      }

      recordActivity({
        organizationId: app.organizationId,
        action: "app.env_revealed",
        appId,
        userId: context.userId,
        metadata: { source: "mcp" },
      }).catch(() => {});

      if (!app.envContent) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ content: "" }),
            },
          ],
        };
      }

      // Env content is encrypted with the owning app's org as the key context.
      const { content: decrypted, wasEncrypted } = decryptOrFallback(
        app.envContent,
        app.organizationId
      );

      if (!decrypted && !wasEncrypted) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                content: "",
                error: "Failed to decrypt env vars — check ENCRYPTION_MASTER_KEY",
              }),
            },
          ],
          isError: true,
        };
      }

      // Encrypts unmigrated plaintext on read.
      if (!wasEncrypted && decrypted) {
        const encrypted = encrypt(decrypted, app.organizationId);
        await db.update(apps).set({ envContent: encrypted }).where(eq(apps.id, appId));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ content: decrypted }, null, 2),
          },
        ],
      };
    }
  );
}
