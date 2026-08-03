import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { stopProject } from "@/lib/docker/deploy";
import { assertAppDirOwnership, AppDirOwnershipError } from "@/lib/docker/app-dir-owner";
import { recordActivity } from "@/lib/activity";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isOrgAdmin } from "@/lib/auth/permissions";
import { refuseSystemManaged } from "@/lib/api/system-managed";
import { sharedMarkerTypeErrors } from "@/lib/docker/compose";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const updateAppSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  containerPort: z.number().int().positive().nullable().optional(),
  autoTraefikLabels: z.boolean().optional(),
  autoDeploy: z.boolean().optional(),
  gitBranch: z.string().nullable().optional(),
  rootDirectory: z.string().nullable().optional(),
  source: z.enum(["git", "direct"]).optional(),
  deployType: z.enum(["compose", "dockerfile", "image", "static", "nixpacks", "railpack"]).optional(),
  composeContent: z.string().max(512000).nullable().optional(),
  composeFilePath: z.string().regex(/^[a-zA-Z0-9._-][a-zA-Z0-9._\-/]*$/, "Invalid file path").nullable().optional(),
  dockerfilePath: z.string().regex(/^[a-zA-Z0-9._-][a-zA-Z0-9._\-/]*$/, "Invalid file path").nullable().optional(),
  gitUrl: z.string().nullable().optional(),
  imageName: z.string().nullable().optional(),
  restartPolicy: z.string().nullable().optional(),
  exposedPorts: z.array(z.object({
    internal: z.number().int().positive(),
    external: z.number().int().positive().optional(),
    protocol: z.string().optional(),
    description: z.string().optional(),
  })).nullable().optional(),
  cpuLimit: z.number().positive().max(64).nullable().optional(),
  memoryLimit: z.number().int().min(64).max(65536).nullable().optional(),
  priority: z.enum(["critical", "standard", "disposable"]).nullable().optional(), // null = inherit parent (decomposed child)
  gpuEnabled: z.boolean().optional(),
  backendProtocol: z.enum(["http", "https"]).nullable().optional(),
  diskWriteAlertThreshold: z.number().int().min(0).nullable().optional(), // bytes/hour, null = default 1GB
  healthCheckTimeout: z.number().int().min(10).max(600).nullable().optional(),
  autoRollback: z.boolean().optional(),
  rollbackGracePeriod: z.number().int().min(10).max(600).optional(),
  projectId: z.string().min(1).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  cloneStrategy: z.enum(["clone", "clone_data", "empty", "skip"]).optional(),
  dependsOn: z.array(z.string()).nullable().optional(),
}).strict();

// GET /api/v1/organizations/[orgId]/apps/[appId]
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ app });
  } catch (error) {
    return handleRouteError(error, "Error fetching app");
  }
}

// PATCH /api/v1/organizations/[orgId]/apps/[appId]
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = updateAppSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // GPU passthrough grants direct host hardware access — restrict to owner/admin
    if (parsed.data.gpuEnabled === true && !isOrgAdmin(org.membership.role)) {
      return NextResponse.json(
        { error: "Only owners and admins can enable GPU passthrough" },
        { status: 403 }
      );
    }

    const existingApp = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, projectId: true, isSystemManaged: true, composeContent: true },
    });
    if (!existingApp) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const refused = refuseSystemManaged(existingApp, "edit");
    if (refused) return refused;

    // A quoted x-vardo-shared is dropped by the parser, so it has to be caught
    // against the raw YAML — before the compose is stored.
    const markerErrors = sharedMarkerTypeErrors(parsed.data.composeContent ?? "");
    if (markerErrors.length > 0) {
      return NextResponse.json(
        { error: markerErrors.join("\n"), errors: markerErrors },
        { status: 400 }
      );
    }

    // Validate projectId changes — must belong to same org
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
      parsed.data.composeContent !== undefined &&
      parsed.data.composeContent !== existingApp.composeContent;

    const [updated] = await db
      .update(apps)
      .set({
        ...parsed.data,
        ...(composeChanged ? { needsRedeploy: true } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(apps.id, appId), eq(apps.organizationId, orgId))
      )
      .returning();

    // Clean up empty projects after moving an app
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
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    recordActivity({
      organizationId: orgId,
      action: "app.updated",
      appId,
      userId: org.session.user.id,
      metadata: { changes: Object.keys(parsed.data) },
    });

    return NextResponse.json({ app: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating app");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if (!isOrgAdmin(org.membership.role)) {
      return NextResponse.json(
        { error: "Only owners and admins can delete apps" },
        { status: 403 }
      );
    }

    // Fetch app before deleting
    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, projectId: true, isSystemManaged: true, parentAppId: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const refused = refuseSystemManaged(app, "delete");
    if (refused) return refused;

    // A decomposed compose child is managed by its parent stack — refuse
    // independent deletes (the compose declares it; a deploy would recreate it).
    if (app.parentAppId) {
      return NextResponse.json(
        { error: "This service is part of a compose stack and can't be deleted on its own. Remove it from the stack's compose file and redeploy." },
        { status: 409 }
      );
    }

    // The stop below swallows failures, so the ownership refusal is surfaced
    // here — deleting the row anyway would strand another app's containers.
    try {
      await assertAppDirOwnership({ appId, appName: app.name, operation: "delete" });
    } catch (err) {
      if (err instanceof AppDirOwnershipError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }

    // Stop containers and remove volumes before deleting
    try {
      await stopProject(appId, app.name, undefined, true);
    } catch { /* containers may not be running */ }

    await db
      .delete(apps)
      .where(and(eq(apps.id, appId), eq(apps.organizationId, orgId)));

    // Clean up empty projects — if this was the last app, delete the project
    if (app.projectId) {
      const { projects } = await import("@/lib/db/schema");
      const remaining = await db.query.apps.findFirst({
        where: eq(apps.projectId, app.projectId),
        columns: { id: true },
      });
      if (!remaining) {
        await db.delete(projects).where(eq(projects.id, app.projectId));
      }
    }

    recordActivity({
      organizationId: orgId,
      action: "app.deleted",
      userId: org.session.user.id,
      metadata: { name: app.name },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting app");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-apps" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-apps" });
