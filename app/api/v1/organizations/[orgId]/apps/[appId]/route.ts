import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects, RESOURCE_PROFILES, SERVICE_KINDS } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { cpuLimitSchema, repoFilePathSchema, imageRefSchema } from "@/lib/api/create-app-schema";
import { deleteApp } from "@/lib/docker/delete-app";
import { assertAppDirOwnership, AppDirOwnershipError } from "@/lib/docker/app-dir-owner";
import { recordActivity } from "@/lib/activity";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { can } from "@/lib/auth/permissions";
import { refuseSystemManaged } from "@/lib/api/system-managed";
import { sharedMarkerTypeErrors } from "@/lib/docker/compose";
import { MaskedComposeError, unmaskComposeEnv } from "@/lib/docker/compose-mask";
import { readableApp } from "@/lib/api/readable-app";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { GIT_URL_MASKED_MESSAGE, gitBranchUpdateSchema, gitUrlUpdateSchema } from "@/lib/api/git-fields";
import { gitUrlUpdateColumns } from "@/lib/api/git-credentials";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const buildOverrideSchema = z
  .string()
  .max(1000)
  .refine((v) => !/[\r\n\0]/.test(v), "Must be one line")
  .transform((v) => v.trim() || null)
  .nullable()
  .optional();

const updateAppSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  containerPort: z.number().int().positive().nullable().optional(),
  autoTraefikLabels: z.boolean().optional(),
  autoDeploy: z.boolean().optional(),
  gitBranch: gitBranchUpdateSchema.nullable().optional(),
  rootDirectory: z.string().nullable().optional(),
  source: z.enum(["git", "direct"]).optional(),
  deployType: z.enum(["compose", "dockerfile", "image", "static", "nixpacks", "railpack"]).optional(),
  composeContent: z.string().max(512000).nullable().optional(),
  composeFilePath: repoFilePathSchema.nullable().optional(),
  dockerfilePath: repoFilePathSchema.nullable().optional(),
  // Buildpack overrides. Null or blank lets the engine decide.
  buildCommand: buildOverrideSchema,
  startCommand: buildOverrideSchema,
  buildProvider: z.enum(["railpack", "nixpacks"]).nullable().optional(),
  gitUrl: gitUrlUpdateSchema.nullable().optional(),
  imageName: imageRefSchema.nullable().optional(),
  restartPolicy: z.string().nullable().optional(),
  exposedPorts: z.array(z.object({
    internal: z.number().int().positive(),
    external: z.number().int().positive().optional(),
    protocol: z.string().optional(),
    description: z.string().optional(),
  })).nullable().optional(),
  cpuLimit: cpuLimitSchema.nullable().optional(),
  memoryLimit: z.number().int().min(64).max(65536).nullable().optional(),
  // Null follows the org default.
  memoryProfile: z.enum(RESOURCE_PROFILES).nullable().optional(),
  // MB: the burstable baseline and the Auto bounds.
  memoryReservation: z.number().int().min(64).max(65536).nullable().optional(),
  memoryAutoMinMb: z.number().int().min(64).max(65536).nullable().optional(),
  memoryAutoMaxMb: z.number().int().min(64).max(1048576).nullable().optional(),
  priority: z.enum(["critical", "standard", "disposable"]).nullable().optional(), // null = inherit parent (decomposed child)
  gpuEnabled: z.boolean().optional(),
  // Null goes back to the kind inferred on deploy.
  kindOverride: z.enum(SERVICE_KINDS).nullable().optional(),
  // Services that get the app's own certificates at /certs. Null or empty turns it off.
  certServices: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).max(63)).max(32).nullable().optional(),
  backendProtocol: z.enum(["http", "https"]).nullable().optional(),
  securityHeaders: z.boolean().optional(),
  diskWriteAlertThreshold: z.number().int().min(0).nullable().optional(), // bytes/hour, null = default 1GB
  anomalyAlerts: z.boolean().optional(),
  healthCheckTimeout: z.number().int().min(10).max(600).nullable().optional(),
  autoRollback: z.boolean().optional(),
  rollbackGracePeriod: z.number().int().min(10).max(600).optional(),
  projectId: z.string().min(1).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  cloneStrategy: z.enum(["clone", "clone_data", "empty", "skip"]).optional(),
  dependsOn: z.array(z.string()).nullable().optional(),
}).strict()
  .refine((d) => !(d.memoryReservation && d.memoryLimit && d.memoryReservation > d.memoryLimit), {
    message: "The guaranteed memory can't be more than the limit",
    path: ["memoryReservation"],
  })
  .refine((d) => !(d.memoryAutoMinMb && d.memoryAutoMaxMb && d.memoryAutoMinMb > d.memoryAutoMaxMb), {
    message: "The Auto floor can't be above its ceiling",
    path: ["memoryAutoMinMb"],
  });

// Only an explicit `true` destroys volumes and bind-mounted data.
const deleteAppSchema = z.object({
  deleteVolumes: z.boolean().optional().default(false),
}).strict();

// GET /api/v1/organizations/[orgId]/apps/[appId]
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId)
      ),
      with: {
        deployments: {
          orderBy: (d, { desc }) => [desc(d.startedAt)],
          limit: 10,
        },
        domains: true,
        envVars: {
          columns: { id: true, key: true, isSecret: true, createdAt: true, updatedAt: true },
        },
      },
    });

    if (!app) {
      return apiError.notFound("app");
    }

    return NextResponse.json({ app: readableApp(app, can(org.membership, "env.reveal")) });
  } catch (error) {
    return handleRouteError(error, "Error fetching app");
  }
}

// PATCH /api/v1/organizations/[orgId]/apps/[appId]
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.config");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = updateAppSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    // GPU passthrough grants host hardware access; owner/admin only.
    if (parsed.data.gpuEnabled === true && !can(org.membership, "app.gpu")) {
      return NextResponse.json(
        { error: "Only owners and admins can enable GPU passthrough" },
        { status: 403 }
      );
    }

    if (parsed.data.certServices !== undefined && !can(org.membership, "app.certs")) {
      return NextResponse.json(
        { error: "Only owners and admins can give an app its certificates" },
        { status: 403 }
      );
    }
    if (parsed.data.certServices?.length === 0) parsed.data.certServices = null;

    const existingApp = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, projectId: true, isSystemManaged: true, composeContent: true, gitUrl: true, gitCredentials: true },
    });
    if (!existingApp) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(existingApp, "edit");
    if (refused) return refused;

    let gitColumns: ReturnType<typeof gitUrlUpdateColumns> | undefined;
    if (parsed.data.gitUrl !== undefined) {
      gitColumns = gitUrlUpdateColumns(parsed.data.gitUrl, existingApp, orgId);
      if (!gitColumns) return NextResponse.json({ error: GIT_URL_MASKED_MESSAGE }, { status: 400 });
    }

    // A masked read sent back keeps the saved values.
    if (parsed.data.composeContent) {
      try {
        parsed.data.composeContent = unmaskComposeEnv(parsed.data.composeContent, existingApp.composeContent);
      } catch (err) {
        if (err instanceof MaskedComposeError) return NextResponse.json({ error: err.message }, { status: 400 });
        throw err;
      }
    }

    // The parser drops a quoted x-vardo-shared, so check the raw YAML before storing.
    const markerErrors = sharedMarkerTypeErrors(parsed.data.composeContent ?? "");
    if (markerErrors.length > 0) {
      return NextResponse.json(
        { error: markerErrors.join("\n"), errors: markerErrors },
        { status: 400 }
      );
    }

    // projectId must belong to this org.
    let oldProjectId: string | null = null;
    if ("projectId" in parsed.data) {
      if (parsed.data.projectId) {
        const project = await db.query.projects.findFirst({
          where: and(eq(projects.id, parsed.data.projectId), eq(projects.organizationId, orgId)),
          columns: { id: true },
        });
        if (!project) {
          return NextResponse.json({ error: "Project not found" }, { status: 400 });
        }
      }
      oldProjectId = existingApp.projectId;
    }

    // An edited compose file only reaches containers on the next deploy.
    const composeChanged =
      (parsed.data.composeContent !== undefined &&
        parsed.data.composeContent !== existingApp.composeContent) ||
      parsed.data.certServices !== undefined;

    const [updated] = await db
      .update(apps)
      .set({
        ...parsed.data,
        ...gitColumns,
        ...(composeChanged ? { needsRedeploy: true } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(apps.id, appId), eq(apps.organizationId, orgId))
      )
      .returning();

    // Clean up empty projects after a move.
    if (oldProjectId && oldProjectId !== updated?.projectId) {
      const remaining = await db.query.apps.findFirst({
        where: eq(apps.projectId, oldProjectId),
        columns: { id: true },
      });
      if (!remaining) {
        await db.delete(projects).where(eq(projects.id, oldProjectId));
      }
    }

    if (!updated) {
      return apiError.notFound("app");
    }

    recordActivity({
      organizationId: orgId,
      action: "app.updated",
      appId,
      userId: org.session.user.id,
      metadata: { changes: Object.keys(parsed.data) },
    });

    return NextResponse.json({ app: readableApp(updated, can(org.membership, "env.reveal")) });
  } catch (error) {
    return handleRouteError(error, "Error updating app");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.delete");
    if (!org) return apiError.forbidden();

    const raw = await request.text();
    let body: unknown = {};
    try {
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = deleteAppSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, projectId: true, isSystemManaged: true, parentAppId: true },
    });

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = refuseSystemManaged(app, "delete");
    if (refused) return refused;

    // A compose child is managed by its parent stack; a deploy would recreate it.
    if (app.parentAppId) {
      return NextResponse.json(
        { error: "This service is part of a compose stack and can't be deleted on its own. Remove it from the stack's compose file and redeploy." },
        { status: 409 }
      );
    }

    // deleteApp checks this too; checked here so the refusal returns 409.
    try {
      await assertAppDirOwnership({ appId, appName: app.name, operation: "delete" });
    } catch (err) {
      if (err instanceof AppDirOwnershipError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }

    const result = await deleteApp({
      appId,
      organizationId: orgId,
      userId: org.session.user.id,
      deleteVolumes: parsed.data.deleteVolumes,
      source: "api",
    });

    return NextResponse.json({
      success: true,
      removedVolumes: result.removedVolumes,
      keptVolumes: result.keptVolumes,
      skippedVolumes: result.skippedVolumes,
      keptPaths: result.keptPaths,
      removedAppDir: result.removedAppDir,
      deletedProject: result.deletedProject,
    });
  } catch (error) {
    return handleRouteError(error, "Error deleting app");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-apps" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-apps" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*" });
