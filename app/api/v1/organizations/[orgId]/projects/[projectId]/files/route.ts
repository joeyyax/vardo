import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectFiles, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, desc } from "drizzle-orm";
import { getUploadUrl, generateFileKey, isR2Configured } from "@/lib/r2";
import { logFileUploaded } from "@/lib/activity";
import { v4 as uuidv4 } from "uuid";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
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

// GET /api/v1/organizations/[orgId]/projects/[projectId]/files
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Get optional tag filter
    const { searchParams } = new URL(request.url);
    const tagFilter = searchParams.get("tag");

    const files = await db.query.projectFiles.findMany({
      where: eq(projectFiles.projectId, projectId),
      orderBy: [desc(projectFiles.createdAt)],
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

    // Filter by tag if provided
    const filteredFiles = tagFilter
      ? files.filter((f) => f.tags?.includes(tagFilter))
      : files;

    // Get unique tags for filter UI
    const allTags = [...new Set(files.flatMap((f) => f.tags || []))].sort();

    return NextResponse.json({
      files: filteredFiles,
      tags: allTags,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching files:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/files
// Creates a file record and returns a presigned upload URL
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Check if R2 is configured
    if (!isR2Configured()) {
      return NextResponse.json(
        { error: "File storage is not configured" },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { name, sizeBytes, mimeType, tags, isPublic, replacesId } = body;

    // Validate required fields
    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "File name is required" }, { status: 400 });
    }
    if (!sizeBytes || typeof sizeBytes !== "number" || sizeBytes <= 0) {
      return NextResponse.json({ error: "Valid file size is required" }, { status: 400 });
    }
    if (!mimeType || typeof mimeType !== "string") {
      return NextResponse.json({ error: "MIME type is required" }, { status: 400 });
    }

    // Size limit (100MB)
    const maxSize = 100 * 1024 * 1024;
    if (sizeBytes > maxSize) {
      return NextResponse.json(
        { error: "File size exceeds 100MB limit" },
        { status: 400 }
      );
    }

    // Validate replacesId if provided
    if (replacesId) {
      const existing = await db.query.projectFiles.findFirst({
        where: eq(projectFiles.id, replacesId),
      });
      if (!existing || existing.projectId !== projectId) {
        return NextResponse.json(
          { error: "Invalid replacesId — file not found in this project" },
          { status: 400 }
        );
      }
    }

    // Generate file ID and R2 key
    const fileId = uuidv4();
    const r2Key = generateFileKey(orgId, projectId, fileId, name);

    // Create the file record (pending upload)
    const [file] = await db
      .insert(projectFiles)
      .values({
        id: fileId,
        projectId,
        uploadedBy: session.user.id,
        name,
        sizeBytes,
        mimeType,
        r2Key,
        tags: Array.isArray(tags) ? tags : [],
        isPublic: isPublic === true,
        replacesId: replacesId || null,
      })
      .returning();

    // Log the activity
    await logFileUploaded({
      projectId,
      actorId: session.user.id,
      fileId,
      fileName: name,
      fileSize: sizeBytes,
    });

    // Generate presigned upload URL
    const uploadUrl = await getUploadUrl(r2Key, mimeType, 3600);

    return NextResponse.json(
      {
        file,
        uploadUrl,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating file:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
