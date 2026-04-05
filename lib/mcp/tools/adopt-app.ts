import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps, domains, environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  parseCompose,
  sanitizeCompose,
  injectNetwork,
  composeToYaml,
  excludeServices,
} from "@/lib/docker/compose";
import { readProjectConfig } from "@/lib/config/vardo-config";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { recordActivity } from "@/lib/activity";
import { resolveProjectForImport } from "@/lib/docker/import";
import { readFile } from "fs/promises";
import { resolve, basename } from "path";
import { slugify } from "@/lib/ui/slugify";
import type { McpAuthContext } from "../auth";

export function registerAdoptApp(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_adopt_app",
    "Adopt an existing project directory into Vardo. Reads docker-compose.yml and optional vardo.yml from the given path, creates the app with a local environment.",
    {
      path: z
        .string()
        .min(1)
        .describe(
          "Filesystem path to the project directory containing docker-compose.yml"
        ),
      name: z
        .string()
        .optional()
        .describe(
          "App slug (lowercase, hyphens). Defaults to directory name."
        ),
      displayName: z
        .string()
        .optional()
        .describe("Human-readable app name. Defaults to directory name."),
      environmentType: z
        .enum(["local", "production", "staging", "preview"])
        .default("local")
        .describe("Environment type to create (default: local)"),
      projectId: z
        .string()
        .optional()
        .describe("Existing project ID to link to"),
      newProjectName: z
        .string()
        .optional()
        .describe("Create a new project with this name"),
      domain: z
        .string()
        .optional()
        .describe("Custom domain (default: <name>.localhost)"),
      containerPort: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Primary container port (default: 3000)"),
    },
    async ({
      path: dirPath,
      name,
      displayName,
      environmentType,
      projectId,
      newProjectName,
      domain,
      containerPort,
    }) => {
      // Require a project
      if (!projectId && !newProjectName) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Either projectId or newProjectName is required" }) }],
          isError: true,
        };
      }

      // Read docker-compose.yml from the directory
      const composePath = resolve(dirPath, "docker-compose.yml");
      let composeContent: string;
      try {
        composeContent = await readFile(composePath, "utf-8");
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `No docker-compose.yml found at ${composePath}`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Read optional vardo.yml
      const projectConfig = await readProjectConfig(dirPath);

      // Derive defaults from directory name
      const dirName = basename(dirPath);
      const effectiveName = name ?? slugify(dirName);
      const effectiveDisplayName = displayName ?? dirName;

      // Check for duplicate slug
      const existing = await db.query.apps.findFirst({
        where: and(
          eq(apps.organizationId, context.organizationId),
          eq(apps.name, effectiveName)
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

      // Parse and process compose
      let compose = parseCompose(composeContent);

      // Apply exclusions from vardo.yml
      const envConfig = projectConfig?.environments?.[environmentType];
      const excludeList = envConfig?.exclude ?? [];
      if (excludeList.length > 0) {
        compose = excludeServices(compose, excludeList);
      }

      // Sanitize — bind mounts allowed for local
      const { compose: sanitized } = sanitizeCompose(compose, {
        allowBindMounts: environmentType === "local",
      });
      compose = sanitized;

      // Domain and port
      const effectiveDomain =
        domain ?? envConfig?.domain ?? `${effectiveName}.localhost`;
      const effectivePort = containerPort ?? 3000;

      // Inject shared network only - Traefik labels are handled by file-provider
      // since autoTraefikLabels=true. This avoids conflicts between Docker provider
      // discovery and explicit file config.
      const sslConfig = await getSslConfig();
      const certResolver = getPrimaryIssuer(sslConfig);
      compose = injectNetwork(compose, "vardo-network");

      const finalCompose = composeToYaml(compose);

      // Create app + environment in a transaction
      const result = await db.transaction(async (tx) => {
        const resolvedProjectId = await resolveProjectForImport(
          tx,
          context.organizationId,
          projectId ?? null,
          newProjectName
        );

        const appId = nanoid();
        const [app] = await tx
          .insert(apps)
          .values({
            id: appId,
            organizationId: context.organizationId,
            name: effectiveName,
            displayName: effectiveDisplayName,
            source: "direct",
            deployType: "compose",
            composeContent: finalCompose,
            autoTraefikLabels: true,
            containerPort: effectivePort,
            projectId: resolvedProjectId,
            status: "active",
          })
          .returning();

        await tx.insert(environments).values({
          id: nanoid(),
          appId,
          name: environmentType,
          type: environmentType,
          domain: effectiveDomain,
          isDefault: true,
        });

        await tx.insert(domains).values({
          id: nanoid(),
          appId,
          domain: effectiveDomain,
          port: effectivePort,
          certResolver,
          isPrimary: true,
        });

        return { app };
      });

      recordActivity({
        organizationId: context.organizationId,
        action: "app.adopted",
        appId: result.app.id,
        metadata: {
          name: effectiveName,
          displayName: effectiveDisplayName,
          environmentType,
          excludedServices: excludeList,
          source: "mcp",
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                app: result.app,
                environmentType,
                domain: effectiveDomain,
                excludedServices: excludeList,
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
