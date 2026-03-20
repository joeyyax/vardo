import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, groups } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { stopProject } from "@/lib/docker/deploy";

/** Delete a group if it has no remaining projects. */
async function cleanupEmptyGroup(groupId: string) {
  const remaining = await db.query.projects.findFirst({
    where: eq(projects.groupId, groupId),
    columns: { id: true },
  });
  if (!remaining) {
    await db.delete(groups).where(eq(groups.id, groupId));
  }
}

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
  groupId: z.string().nullable().optional(),
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
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

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

    // Check if groupId is changing so we can clean up the old group
    let oldGroupId: string | null = null;
    if ("groupId" in parsed.data) {
      const existing = await db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
        columns: { groupId: true },
      });
      oldGroupId = existing?.groupId ?? null;
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

    // Clean up old group if it's now empty
    if (oldGroupId && oldGroupId !== updated.groupId) {
      await cleanupEmptyGroup(oldGroupId);
    }

    return NextResponse.json({ project: updated });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, membership } = await requireOrg();

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
      columns: { id: true, name: true, groupId: true },
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

    // Clean up group if it's now empty
    if (project.groupId) {
      await cleanupEmptyGroup(project.groupId);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
