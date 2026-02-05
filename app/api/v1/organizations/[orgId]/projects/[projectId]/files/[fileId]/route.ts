import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectFiles, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getDownloadUrl, getViewUrl, deleteFile, isR2Configured } from "@/lib/r2";
import { logFileDeleted } from "@/lib/activity";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; fileId: string }>;
};

/**
 * Verify that the project belongs to the organization.
 */
async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: true,
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }

  return project;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/files/[fileId]
// Returns file details and download/view URLs
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, fileId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const file = await db.query.projectFiles.findFirst({
      where: and(
        eq(projectFiles.id, fileId),
        eq(projectFiles.projectId, projectId)
      ),
      with: {
        uploadedByUser: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!file) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    // Check if R2 is configured before generating URLs
    if (!isR2Configured()) {
      return NextResponse.json({
        ...file,
        downloadUrl: null,
        viewUrl: null,
        storageConfigured: false,
      });
    }

    // Generate presigned URLs
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action"); // 'download' | 'view'

    let downloadUrl: string | null = null;
    let viewUrl: string | null = null;

    if (action === "download" || !action) {
      downloadUrl = await getDownloadUrl(file.r2Key, 3600, file.name);
    }
    if (action === "view" || !action) {
      viewUrl = await getViewUrl(file.r2Key, 3600);
    }

    return NextResponse.json({
      ...file,
      downloadUrl,
      viewUrl,
      storageConfigured: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching file:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]/files/[fileId]
// Update file metadata (tags, isPublic)
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, fileId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const file = await db.query.projectFiles.findFirst({
      where: and(
        eq(projectFiles.id, fileId),
        eq(projectFiles.projectId, projectId)
      ),
    });

    if (!file) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const body = await request.json();
    const { tags, isPublic, name } = body;

    const updateData: Record<string, unknown> = {};

    if (Array.isArray(tags)) {
      updateData.tags = tags;
    }
    if (typeof isPublic === "boolean") {
      updateData.isPublic = isPublic;
    }
    if (typeof name === "string" && name.trim()) {
      updateData.name = name.trim();
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const [updated] = await db
      .update(projectFiles)
      .set(updateData)
      .where(eq(projectFiles.id, fileId))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error updating file:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/files/[fileId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, fileId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const file = await db.query.projectFiles.findFirst({
      where: and(
        eq(projectFiles.id, fileId),
        eq(projectFiles.projectId, projectId)
      ),
    });

    if (!file) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    // Log the activity before deletion
    await logFileDeleted({
      projectId,
      actorId: session.user.id,
      fileId,
      fileName: file.name,
    });

    // Delete from R2 if configured
    if (isR2Configured()) {
      try {
        await deleteFile(file.r2Key);
      } catch (r2Error) {
        console.error("Error deleting file from R2:", r2Error);
        // Continue with database deletion even if R2 fails
      }
    }

    // Delete from database
    await db.delete(projectFiles).where(eq(projectFiles.id, fileId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error deleting file:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
