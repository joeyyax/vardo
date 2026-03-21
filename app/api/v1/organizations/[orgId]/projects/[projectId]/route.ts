import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { stopProject } from "@/lib/docker/deploy";
import { recordActivity } from "@/lib/activity";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

const updateProjectSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  containerPort: z.number().int().positive().nullable().optional(),
  autoTraefikLabels: z.boolean().optional(),
  autoDeploy: z.boolean().optional(),
  gitBranch: z.string().nullable().optional(),
  rootDirectory: z.string().nullable().optional(),
  source: z.enum(["git", "direct"]).optional(),
  deployType: z.enum(["compose", "dockerfile", "image", "static", "nixpacks"]).optional(),
  gitUrl: z.string().nullable().optional(),
  imageName: z.string().nullable().optional(),
  restartPolicy: z.string().nullable().optional(),
  exposedPorts: z.array(z.object({
    internal: z.number().int().positive(),
    external: z.number().int().positive().optional(),
    protocol: z.string().optional(),
    description: z.string().optional(),
  })).nullable().optional(),
  parentId: z.string().nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  cloneStrategy: z.enum(["clone", "clone_data", "empty", "skip"]).optional(),
  dependsOn: z.array(z.string()).nullable().optional(),
});

// GET /api/v1/organizations/[orgId]/projects/[projectId]
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, orgId)
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

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ project });
  } catch (error) {
    return handleRouteError(error, "Error fetching project");
  }
}

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = updateProjectSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Validate parentId changes — enforce single-level nesting
    if (parsed.data.parentId) {
      // Can't assign to a parent that is itself a child
      const parent = await db.query.projects.findFirst({
        where: and(eq(projects.id, parsed.data.parentId), eq(projects.organizationId, orgId)),
        columns: { id: true, parentId: true },
      });
      if (!parent) {
        return NextResponse.json({ error: "Parent project not found" }, { status: 400 });
      }
      if (parent.parentId) {
        return NextResponse.json({ error: "That project already has a parent" }, { status: 400 });
      }
      // Can't become a child if this project already has children (no nesting)
      const hasChildren = await db.query.projects.findFirst({
        where: eq(projects.parentId, projectId),
        columns: { id: true },
      });
      if (hasChildren) {
        return NextResponse.json({ error: "Parent projects cannot be nested" }, { status: 400 });
      }
    }

    const [updated] = await db
      .update(projects)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(
        and(eq(projects.id, projectId), eq(projects.organizationId, orgId))
      )
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    recordActivity({
      organizationId: orgId,
      action: "project.updated",
      projectId,
      userId: session.user.id,
      metadata: { changes: Object.keys(parsed.data) },
    });

    return NextResponse.json({ project: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating project");
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, membership, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (membership.role !== "owner" && membership.role !== "admin") {
      return NextResponse.json(
        { error: "Only owners and admins can delete projects" },
        { status: 403 }
      );
    }

    // Fetch project before deleting
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true, name: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Stop containers before deleting
    try {
      await stopProject(projectId, project.name);
    } catch { /* containers may not be running */ }

    await db
      .delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, orgId)));

    recordActivity({
      organizationId: orgId,
      action: "project.deleted",
      userId: session.user.id,
      metadata: { name: project.name },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting project");
  }
}
