import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { taskFiles, tasks, projects, projectFiles } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; taskId: string }>;
};

// POST /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/files
// Link an existing project file to a task
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify project belongs to org
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { client: true },
    });
    if (!project || project.client.organizationId !== orgId) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Verify task belongs to project
    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
    });
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const body = await request.json();
    const { fileId } = body;

    if (!fileId || typeof fileId !== "string") {
      return NextResponse.json({ error: "fileId is required" }, { status: 400 });
    }

    // Verify file belongs to the same project
    const file = await db.query.projectFiles.findFirst({
      where: and(
        eq(projectFiles.id, fileId),
        eq(projectFiles.projectId, projectId)
      ),
    });
    if (!file) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    // Check if already linked
    const existing = await db.query.taskFiles.findFirst({
      where: and(eq(taskFiles.taskId, taskId), eq(taskFiles.fileId, fileId)),
    });
    if (existing) {
      return NextResponse.json({ message: "File already linked" });
    }

    await db.insert(taskFiles).values({ taskId, fileId });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error linking file to task:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/files
// Unlink a file from a task (does not delete the project file)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify project belongs to org
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { client: true },
    });
    if (!project || project.client.organizationId !== orgId) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const { fileId } = body;

    if (!fileId || typeof fileId !== "string") {
      return NextResponse.json({ error: "fileId is required" }, { status: 400 });
    }

    await db
      .delete(taskFiles)
      .where(and(eq(taskFiles.taskId, taskId), eq(taskFiles.fileId, fileId)));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error unlinking file from task:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
