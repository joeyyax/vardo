import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects, apps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, or } from "drizzle-orm";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]
// Returns a single project with its apps
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(
        or(eq(projects.id, projectId), eq(projects.name, projectId)),
        eq(projects.organizationId, orgId)
      ),
      with: {
        apps: {
          columns: { id: true, name: true, displayName: true, status: true },
        },
      },
    });

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
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens")
    .optional(),
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]
// Updates a project's displayName, description, or color
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const existing = await db.query.projects.findFirst({
      where: and(
        or(eq(projects.id, projectId), eq(projects.name, projectId)),
        eq(projects.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
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

    const [updated] = await db
      .update(projects)
      .set(parsed.data)
      .where(eq(projects.id, existing.id))
      .returning();

    return NextResponse.json({ project: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating project");
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]
// Deletes the project but detaches (not deletes) its apps first
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await db.query.projects.findFirst({
      where: and(
        or(eq(projects.id, projectId), eq(projects.name, projectId)),
        eq(projects.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
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
