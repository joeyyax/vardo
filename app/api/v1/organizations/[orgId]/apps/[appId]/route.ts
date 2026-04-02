import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { stopProject } from "@/lib/docker/deploy";
import { recordActivity } from "@/lib/activity";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isAdmin } from "@/lib/auth/permissions";

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
  gpuEnabled: z.boolean().optional(),
  backendProtocol: z.enum(["http", "https"]).nullable().optional(),
  diskWriteAlertThreshold: z.number().int().min(0).nullable().optional(), // bytes/hour, null = default 1GB
  healthCheckTimeout: z.number().int().min(10).max(600).nullable().optional(),
  autoRollback: z.boolean().optional(),
  rollbackGracePeriod: z.number().int().min(10).max(600).optional(),
  projectId: z.string().nullable().optional(),
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
export async function PATCH(request: NextRequest, { params }: RouteParams) {
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
    if (parsed.data.gpuEnabled === true && !isAdmin(org.membership.role)) {
      return NextResponse.json(
        { error: "Only owners and admins can enable GPU passthrough" },
        { status: 403 }
      );
    }

    // Verify the app exists and check isSystemManaged before updating
    const existingApp = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, projectId: true, isSystemManaged: true },
    });
    if (!existingApp) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (existingApp.isSystemManaged) {
      return NextResponse.json(
        { error: "System-managed apps cannot be modified via the API" },
        { status: 403 }
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
      oldProjectId = existingApp.projectId ?? null;
    }

    const [updated] = await db
      .update(apps)
      .set({ ...parsed.data, updatedAt: new Date() })
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
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if (!isAdmin(org.membership.role)) {
      return NextResponse.json(
        { error: "Only owners and admins can delete apps" },
        { status: 403 }
      );
    }

    // Fetch app before deleting
    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, projectId: true, isSystemManaged: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (app.isSystemManaged) {
      return NextResponse.json(
        { error: "System-managed apps cannot be deleted via the API" },
        { status: 403 }
      );
    }

    // Stop containers before deleting
    try {
      await stopProject(appId, app.name);
    } catch { /* containers may not be running */ }

    // Disconnect any integration backed by this app
    try {
      const { integrations } = await import("@/lib/db/schema");
      const backedIntegration = await db.query.integrations.findFirst({
        where: eq(integrations.appId, appId),
        columns: { type: true },
      });
      if (backedIntegration) {
        const { disconnectIntegration } = await import("@/lib/integrations");
        await disconnectIntegration(backedIntegration.type as "metrics" | "error_tracking" | "uptime" | "logging");
        if (backedIntegration.type === "metrics") {
          const { reinitMetricsProvider } = await import("@/lib/metrics/config");
          await reinitMetricsProvider();
        }
      }
    } catch { /* integration cleanup is best-effort */ }

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
