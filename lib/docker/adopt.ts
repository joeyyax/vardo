import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { APP_NAME_TAKEN_ERROR, isAppNameViolation, isTopLevelAppNameTaken } from "@/lib/db/app-name";
import { apps, domains, environments, organizations, projects } from "@/lib/db/schema";
import {
  parseCompose,
  sanitizeCompose,
  injectNetwork,
  composeToYaml,
  excludeServices,
  sharedMarkerTypeErrors,
  hostAccessErrors,
} from "@/lib/docker/compose";
import type { ComposeFile } from "@/lib/docker/compose";
import { validateCompose } from "@/lib/docker/compose-validate";
import { getSslConfig, getDefaultCertResolver } from "@/lib/system-settings";
import { recordActivity } from "@/lib/activity";
import { resolveProjectForImport } from "@/lib/docker/import";
import { isFeatureEnabled } from "@/lib/config/features";
import { adoptAllowsBindMounts } from "@/lib/docker/adopt-policy";

/** Largest compose file adopt accepts, in characters. */
export const MAX_ADOPT_COMPOSE_CHARS = 256 * 1024;

const environmentConfigSchema = z.object({
  domain: z.string().optional(),
  exclude: z.array(z.string()).optional(),
});

export const adoptFields = {
  composeContent: z
    .string()
    .min(1, "Compose content is required")
    .max(MAX_ADOPT_COMPOSE_CHARS, `Compose content is limited to ${MAX_ADOPT_COMPOSE_CHARS / 1024} KB`),
  projectConfig: z
    .object({
      name: z.string().optional(),
      environments: z.record(z.string(), environmentConfigSchema).optional(),
      env: z.array(z.string()).optional(),
      resources: z
        .object({
          memory: z.string().optional(),
          cpus: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  environmentType: z.enum(["local", "production", "staging", "preview"]).default("local"),
  name: z
    .string()
    .min(1, "Name is required")
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens"),
  displayName: z.string().min(1, "Display name is required").max(255),
  projectId: z.string().optional(),
  newProjectName: z.string().min(1).max(255).optional(),
  domain: z.string().optional(),
  containerPort: z.number().int().positive().optional(),
};

export const adoptSchema = z.object(adoptFields).refine(
  (data) => !!data.projectId || !!data.newProjectName,
  { message: "Either projectId or newProjectName is required", path: ["projectId"] }
);

export type AdoptInput = z.infer<typeof adoptSchema>;

export type AdoptResult =
  | { ok: true; status: 201; body: Record<string, unknown> }
  | { ok: false; status: 400 | 409; body: Record<string, unknown> };

const fail = (status: 400 | 409, body: Record<string, unknown>): AdoptResult => ({
  ok: false,
  status,
  body,
});

/** Create an app from compose content. Caller checks org membership and parses `data` with adoptSchema. */
export async function adoptCompose(
  data: AdoptInput,
  ctx: { orgId: string; userId: string; source?: string }
): Promise<AdoptResult> {
  const { orgId } = ctx;
  try {
    // Never reveal another org's app id.
    const existingBySlug = await db.query.apps.findFirst({
      where: and(eq(apps.organizationId, orgId), eq(apps.name, data.name)),
      columns: { id: true },
    });
    if (existingBySlug) {
      return fail(409, { error: APP_NAME_TAKEN_ERROR, appId: existingBySlug.id });
    }
    if (await isTopLevelAppNameTaken(data.name)) {
      return fail(409, { error: APP_NAME_TAKEN_ERROR });
    }

    // Checked on raw content: a quoted marker would vanish in the re-serialized compose.
    const markerErrors = sharedMarkerTypeErrors(data.composeContent);
    if (markerErrors.length > 0) {
      return fail(400, { error: markerErrors.join("\n"), errors: markerErrors });
    }

    let compose: ComposeFile;
    try {
      compose = parseCompose(data.composeContent);
    } catch {
      return fail(400, { error: "Invalid docker-compose content" });
    }

    const envConfig = data.projectConfig?.environments?.[data.environmentType];
    const excludeList = envConfig?.exclude ?? [];
    if (excludeList.length > 0) {
      compose = excludeServices(compose, excludeList);
    }

    // Deploy refuses host-reaching settings outside a trusted org; adopt says so now.
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { trusted: true },
    });
    if (!org?.trusted) {
      const hostErrors = hostAccessErrors(compose);
      if (hostErrors.length > 0) {
        return fail(400, { error: hostErrors.join("\n"), errors: hostErrors });
      }
    }

    // Bind mounts follow the project, as on deploy (#767). A new project takes the schema default.
    const adoptProject = data.projectId
      ? await db.query.projects.findFirst({
          where: and(eq(projects.id, data.projectId), eq(projects.organizationId, orgId)),
          columns: { allowBindMounts: true },
        })
      : null;
    const bindMountsEnabled = adoptAllowsBindMounts({
      environmentType: data.environmentType,
      projectAllowBindMounts: adoptProject?.allowBindMounts,
      featureEnabled: isFeatureEnabled("bindMounts"),
    });

    // A denied mount throws.
    let strippedMounts: string[];
    try {
      const sanitized = sanitizeCompose(compose, { allowBindMounts: bindMountsEnabled });
      compose = sanitized.compose;
      strippedMounts = sanitized.strippedMounts;
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : "Compose contains a blocked mount",
      });
    }

    if (!org?.trusted) {
      const { valid, errors } = validateCompose(compose, { allowBindMounts: bindMountsEnabled });
      if (!valid) {
        return fail(400, { error: `Compose validation failed:\n${errors.join("\n")}`, errors });
      }
    }

    const domain = data.domain ?? envConfig?.domain ?? `${data.name}.localhost`;
    const containerPort = data.containerPort ?? 3000;

    const certResolver = getDefaultCertResolver(await getSslConfig());
    compose = injectNetwork(compose, "vardo-network");
    const composeContent = composeToYaml(compose);

    const primaryServiceName = Object.keys(compose.services)[0];
    const containerName = primaryServiceName
      ? `${data.name}-${primaryServiceName}-1`
      : `${data.name}-1`;

    const result = await db.transaction(async (tx) => {
      const resolvedProjectId = await resolveProjectForImport(
        tx,
        orgId,
        data.projectId,
        data.newProjectName
      );

      const appId = nanoid();
      const [app] = await tx
        .insert(apps)
        .values({
          id: appId,
          organizationId: orgId,
          name: data.name,
          displayName: data.displayName,
          source: "direct",
          deployType: "compose",
          composeContent,
          autoTraefikLabels: true,
          containerPort,
          containerName,
          projectId: resolvedProjectId,
          envContent: null,
          status: "active",
        })
        .returning();

      await tx.insert(environments).values({
        id: nanoid(),
        appId,
        name: data.environmentType,
        type: data.environmentType,
        domain,
        isDefault: true,
      });

      await tx.insert(domains).values({
        id: nanoid(),
        appId,
        domain,
        port: containerPort,
        certResolver,
        isPrimary: true,
      });

      return { app };
    });

    recordActivity({
      organizationId: orgId,
      action: "app.adopted",
      appId: result.app.id,
      userId: ctx.userId,
      metadata: {
        name: data.name,
        displayName: data.displayName,
        environmentType: data.environmentType,
        excludedServices: excludeList,
        ...(ctx.source ? { source: ctx.source } : {}),
      },
    });

    return {
      ok: true,
      status: 201,
      body: {
        app: result.app,
        environmentType: data.environmentType,
        domain,
        excludedServices: excludeList,
        // Present even when empty.
        strippedMounts,
      },
    };
  } catch (error) {
    if (isAppNameViolation(error)) return fail(409, { error: APP_NAME_TAKEN_ERROR });
    throw error;
  }
}
