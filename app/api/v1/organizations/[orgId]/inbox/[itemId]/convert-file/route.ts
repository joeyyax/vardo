import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inboxItems, projectFiles, projects } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; itemId: string }>;
};

// POST /api/v1/organizations/[orgId]/inbox/[itemId]/convert-file
// Convert an inbox item's attachments into project files
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch the inbox item with files
    const item = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
      with: { files: true },
    });

    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (item.status === "converted") {
      return NextResponse.json(
        { error: "Item has already been converted" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const resolvedProjectId = body.projectId || item.projectId;

    if (!resolvedProjectId) {
      return NextResponse.json(
        { error: "A project is required for file conversion" },
        { status: 400 }
      );
    }

    if (!item.files || item.files.length === 0) {
      return NextResponse.json(
        { error: "No files attached to this inbox item" },
        { status: 400 }
      );
    }

    // Verify the project belongs to this org
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, resolvedProjectId),
      with: {
        client: { columns: { organizationId: true } },
      },
    });

    if (!project || project.client.organizationId !== orgId) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Insert projectFiles records for each inbox file
    const files = await db
      .insert(projectFiles)
      .values(
        item.files.map((file) => ({
          projectId: resolvedProjectId,
          uploadedBy: session.user.id,
          name: file.name,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
          r2Key: file.r2Key,
          tags: ["inbox"],
        }))
      )
      .returning();

    // Mark inbox item as converted
    await db
      .update(inboxItems)
      .set({
        status: "converted",
        convertedTo: "file",
        updatedAt: new Date(),
      })
      .where(eq(inboxItems.id, itemId));

    return NextResponse.json(
      { files, item: { id: itemId, status: "converted" } },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error converting inbox item to file:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
