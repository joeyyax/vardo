import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tasks, projects, taskRelationships } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, or } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; taskId: string; relationshipId: string }>;
};

async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: { client: true },
  });
  if (!project || project.client.organizationId !== orgId) {
    return null;
  }
  return project;
}

async function verifyTaskBelongsToProject(taskId: string, projectId: string) {
  return db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
  });
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/relationships/[relationshipId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId, relationshipId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const task = await verifyTaskBelongsToProject(taskId, projectId);
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Verify relationship exists and involves this task
    const relationship = await db.query.taskRelationships.findFirst({
      where: and(
        eq(taskRelationships.id, relationshipId),
        or(
          eq(taskRelationships.sourceTaskId, taskId),
          eq(taskRelationships.targetTaskId, taskId)
        )
      ),
    });

    if (!relationship) {
      return NextResponse.json({ error: "Relationship not found" }, { status: 404 });
    }

    await db
      .delete(taskRelationships)
      .where(eq(taskRelationships.id, relationshipId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting relationship:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
