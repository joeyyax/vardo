import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps, projects, environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { encrypt } from "@/lib/crypto/encrypt";
import { recordActivity } from "@/lib/activity";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import type { McpAuthContext } from "../auth";

// 5 app creations per 10 minutes per user/org pair.
const CREATE_RATE_LIMIT = 5;
const CREATE_RATE_WINDOW_MS = 10 * 60 * 1000;

export function registerCreateApp(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_create_app",
    "Create a new standalone app inside a project, deployed from a git repository. Works with any PUBLIC HTTPS git repo — no provider connection needed. Defaults to 'compose' deployType, which auto-detects a compose file, then a Dockerfile, then Nixpacks; pass a different deployType to pin the build. Creates the app record plus its default production environment and returns the new app id. Does NOT deploy — set env/volumes/domains as needed, then call vardo_deploy_app. Compose services are decomposed into child apps automatically on first deploy.",
    {
      projectId: z.string().min(1).describe("The project ID to create the app in"),
      name: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens")
        .describe("App slug (lowercase, hyphens)"),
      displayName: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("Human-readable app name (defaults to the slug)"),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("Optional description"),
      gitUrl: z
        .string()
        .url()
        .refine((url) => url.startsWith("https://"), {
          message: "Only HTTPS git URLs are allowed",
        })
        .describe("HTTPS git repository URL (e.g. 'https://github.com/acme/myapp.git')"),
      gitBranch: z
        .string()
        .regex(/^[a-zA-Z0-9._\-/]+$/, "Invalid branch name")
        .default("main")
        .describe("Branch to deploy (default 'main')"),
      deployType: z
        .enum(["compose", "dockerfile", "image", "static", "nixpacks", "railpack"])
        .default("compose")
        .describe(
          "Build/deploy strategy (default 'compose' = auto-detect compose → Dockerfile → Nixpacks)"
        ),
      composeFilePath: z
        .string()
        .regex(/^[a-zA-Z0-9._-][a-zA-Z0-9._\-/]*$/, "Invalid file path")
        .default("docker-compose.yml")
        .describe("Path to the compose file within the repo (default 'docker-compose.yml')"),
      rootDirectory: z
        .string()
        .optional()
        .describe("Optional subdirectory within the repo to treat as the build/compose root"),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("Initial environment variables as a key/value map (encrypted at rest)"),
    },
    async ({
      projectId,
      name,
      displayName,
      description,
      gitUrl,
      gitBranch,
      deployType,
      composeFilePath,
      rootDirectory,
      env,
    }) => {
      const rl = await slidingWindowRateLimit(
        `${context.userId}:${context.organizationId}`,
        "mcp:create-app",
        CREATE_RATE_LIMIT,
        CREATE_RATE_WINDOW_MS
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

      // Project must exist in this org.
      const project = await db.query.projects.findFirst({
        where: and(
          eq(projects.id, projectId),
          eq(projects.organizationId, context.organizationId)
        ),
        columns: { id: true },
      });
      if (!project) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Project not found in this organization" }),
            },
          ],
          isError: true,
        };
      }

      // Reject duplicate slugs up front for a clean error (the DB also enforces it).
      const existing = await db.query.apps.findFirst({
        where: and(
          eq(apps.organizationId, context.organizationId),
          eq(apps.name, name)
        ),
        columns: { id: true },
      });
      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "An app with this slug already exists",
                appId: existing.id,
              }),
            },
          ],
          isError: true,
        };
      }

      const envContent = env && Object.keys(env).length > 0
        ? encrypt(
            Object.entries(env)
              .map(([k, v]) => `${k}=${v}`)
              .join("\n"),
            context.organizationId
          )
        : null;

      const appId = nanoid();

      const result = await db.transaction(async (tx) => {
        const [app] = await tx
          .insert(apps)
          .values({
            id: appId,
            organizationId: context.organizationId,
            projectId,
            name,
            displayName: displayName ?? name,
            description: description ?? null,
            source: "git",
            deployType,
            gitUrl,
            gitBranch,
            composeFilePath,
            rootDirectory: rootDirectory ?? null,
            envContent,
            status: "stopped",
          })
          .returning();

        await tx.insert(environments).values({
          id: nanoid(),
          appId,
          name: "production",
          type: "production",
          isDefault: true,
        });

        return { app };
      });

      recordActivity({
        organizationId: context.organizationId,
        action: "app.created",
        appId,
        userId: context.userId,
        metadata: { name, displayName: displayName ?? name, source: "mcp" },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                appId: result.app.id,
                app: result.app,
                environment: "production",
                needsDeploy: true,
                message:
                  "App created. Set env vars / volumes / domains if needed, then call vardo_deploy_app.",
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
