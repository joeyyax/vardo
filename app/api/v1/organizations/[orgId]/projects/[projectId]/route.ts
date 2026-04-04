import { NextRequest, NextResponse } from "next/server";
import { handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isOrgAdmin } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import { recordActivity } from "@/lib/activity";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

/** Look up by ID first, then fall back to name. */
async function findProject(orgId: string, projectId: string) {
  let project = await db.query.projects.findFirst({
    where: and(eq(projects.organizationId, orgId), eq(projects.id, projectId)),
    with: {
      apps: {
        columns: { id: true, name: true, displayName: true, status: true },
      },
    },
  });
  if (!project) {
    project = await db.query.projects.findFirst({
      where: and(eq(projects.organizationId, orgId), eq(projects.name, projectId)),
      with: {
        apps: {
          columns: { id: true, name: true, displayName: true, status: true },
        },
      },
    });
  }
  return project;
}

/** Look up by ID first, then fall back to name (without relations). */
async function findProjectBasic(orgId: string, projectId: string) {
  let project = await db.query.projects.findFirst({
    where: and(eq(projects.organizationId, orgId), eq(projects.id, projectId)),
    columns: { id: true, name: true, organizationId: true, isSystemManaged: true },
  });
  if (!project) {
    project = await db.query.projects.findFirst({
      where: and(eq(projects.organizationId, orgId), eq(projects.name, projectId)),
      columns: { id: true, name: true, organizationId: true, isSystemManaged: true },
    });
  }
  return project;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]
// Returns a single project with its apps
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const project = await findProject(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json({ project });
  } catch (error) {
    return handleRouteError(error, "Error fetching project");
  }
}

const updateSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Name must be lowercase alphanumeric with hyphens")
    .optional(),
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  allowBindMounts: z.boolean().optional(),
}).strict();

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]
// Updates a project's displayName, description, or color
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // allowBindMounts is a security-sensitive flag — restrict to admins and owners
    if (parsed.data.allowBindMounts !== undefined && !isOrgAdmin(org.membership.role)) {
      return NextResponse.json({ error: "Only admins can change the bind mounts setting" }, { status: 403 });
    }

    const existing = await findProjectBasic(orgId, projectId);

    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (existing.isSystemManaged) {
      return NextResponse.json(
        { error: "System-managed projects cannot be modified via the API" },
        { status: 403 }
      );
    }

    // Check for name conflicts when renaming
    if (parsed.data.name && parsed.data.name !== existing.name) {
      const conflict = await db.query.projects.findFirst({
        where: and(
          eq(projects.name, parsed.data.name),
          eq(projects.organizationId, orgId)
        ),
      });
      if (conflict) {
        return NextResponse.json(
          { error: "A project with that name already exists" },
          { status: 409 }
        );
      }
    }

    try {
      const [updated] = await db
        .update(projects)
        .set(parsed.data)
        .where(eq(projects.id, existing.id))
        .returning();

      if (parsed.data.allowBindMounts !== undefined) {
        logger.info(
          { projectId: existing.id, userId: org.session.user.id, allowBindMounts: parsed.data.allowBindMounts },
          "allowBindMounts flag changed",
        );
        recordActivity({
          organizationId: orgId,
          action: "project.allow_bind_mounts.updated",
          userId: org.session.user.id,
          metadata: { projectId: existing.id, allowBindMounts: parsed.data.allowBindMounts },
        }).catch(() => {});
      }

      return NextResponse.json({ project: updated });
    } catch (updateError) {
      if (isUniqueViolation(updateError)) {
        return NextResponse.json(
          { error: "A project with that name already exists" },
          { status: 409 }
        );
      }
      throw updateError;
    }
  } catch (error) {
    return handleRouteError(error, "Error updating project");
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]
// Deletes the project but detaches (not deletes) its apps first
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const existing = await findProjectBasic(orgId, projectId);

    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (existing.isSystemManaged) {
      return NextResponse.json(
        { error: "System-managed projects cannot be deleted via the API" },
        { status: 403 }
      );
    }

    // Detach apps from this project (don't delete them)
    await db
      .update(apps)
      .set({ projectId: null })
      .where(eq(apps.projectId, existing.id));

    // Delete the project
    await db
      .delete(projects)
      .where(eq(projects.id, existing.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting project");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-projects" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-projects" });
