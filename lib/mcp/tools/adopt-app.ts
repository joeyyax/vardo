import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { APP_NAME_TAKEN_ERROR, isTopLevelAppNameTaken } from "@/lib/db/app-name";
import { apps, domains, environments, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  parseCompose,
  sanitizeCompose,
  injectNetwork,
  composeToYaml,
  excludeServices,
  sharedMarkerTypeErrors,
} from "@/lib/docker/compose";
import { readProjectConfig } from "@/lib/config/vardo-config";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { recordActivity } from "@/lib/activity";
import { resolveProjectForImport } from "@/lib/docker/import";
import { readFile } from "fs/promises";
import { resolve, basename } from "path";
import { slugify } from "@/lib/ui/slugify";
import type { McpAuthContext } from "../auth";
import { resolveProjectOrg, resolveTargetOrg } from "../scope";
import { isFeatureEnabled } from "@/lib/config/features";
import { adoptAllowsBindMounts } from "@/lib/docker/adopt-policy";
import { generateNamespace } from "@/lib/infra/app-namespace";

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
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization to adopt into when creating a new project (default: the token's own organization). Ignored when projectId is given — the project's own organization wins."
        ),
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
      organizationId,
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

      // An existing project pins the org; otherwise fall back to the requested
      // (membership-checked) org. Never trusts a caller-supplied id on its own.
      const orgId = projectId
        ? await resolveProjectOrg(context, projectId)
        : await resolveTargetOrg(context, organizationId);

      if (!orgId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Project not found or access denied" }),
            },
          ],
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

      // Check for duplicate slug. Only an app in this org can be named back —
      // one held by another org must stay invisible.
      const existing = await db.query.apps.findFirst({
        where: and(
          eq(apps.organizationId, orgId),
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
                error: APP_NAME_TAKEN_ERROR,
                appId: existing.id,
              }),
            },
          ],
          isError: true,
        };
      }
      if (await isTopLevelAppNameTaken(effectiveName)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: APP_NAME_TAKEN_ERROR }),
            },
          ],
          isError: true,
        };
      }

      // Before parseCompose, which drops a non-boolean marker and leaves no trace.
      const markerErrors = sharedMarkerTypeErrors(composeContent);
      if (markerErrors.length > 0) {
        return {
          content: [{ type: "text" as const, text: markerErrors.join("\n") }],
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

      // Bind mounts follow the project, the same source the deploy path reads.
      // Keying this on environmentType alone refused in production what deploy
      // permits in production, for the same project (#767).
      const adoptProject = projectId
        ? await db.query.projects.findFirst({
            where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
            columns: { allowBindMounts: true },
          })
        : null;
      const bindMountsEnabled = adoptAllowsBindMounts({
        environmentType,
        projectAllowBindMounts: adoptProject?.allowBindMounts,
        featureEnabled: isFeatureEnabled("bindMounts"),
      });

      const { compose: sanitized, strippedMounts } = sanitizeCompose(compose, {
        allowBindMounts: bindMountsEnabled,
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
          orgId,
          projectId ?? null,
          newProjectName
        );

        const appId = nanoid();
        const [app] = await tx
          .insert(apps)
          .values({
            id: appId,
            organizationId: orgId,
            name: effectiveName,
            namespace: generateNamespace(effectiveName),
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
        organizationId: orgId,
        action: "app.adopted",
        appId: result.app.id,
        userId: context.userId,
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
                // Named even when empty, so a caller can tell "nothing was
                // stripped" from an older response that could not say.
                strippedMounts,
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
