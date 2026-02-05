import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documents, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { logActivity } from "@/lib/activity";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; documentId: string }>;
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

// POST /api/v1/organizations/[orgId]/projects/[projectId]/documents/[documentId]/send
// Marks a document as sent and optionally sends email notification
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, documentId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const document = await db.query.documents.findFirst({
      where: and(
        eq(documents.id, documentId),
        eq(documents.projectId, projectId),
        eq(documents.organizationId, orgId)
      ),
    });

    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // Can only send draft documents
    if (document.status !== "draft") {
      return NextResponse.json(
        { error: "Document has already been sent" },
        { status: 400 }
      );
    }

    // Validate document has content
    const content = document.content as { sections?: Array<{ content: string }> };
    const hasContent = content?.sections?.some((s) => s.content && s.content.trim().length > 0);
    if (!hasContent) {
      return NextResponse.json(
        { error: "Cannot send an empty document. Add content first." },
        { status: 400 }
      );
    }

    // Update document status to sent
    const [updated] = await db
      .update(documents)
      .set({
        status: "sent",
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId))
      .returning();

    // Log activity
    await logActivity({
      projectId,
      type: "document_sent",
      actorId: session.user.id,
      metadata: {
        documentId,
        documentTitle: document.title,
        documentType: document.type,
      },
      isPublic: true, // Sending a document is visible to clients
    });

    // TODO: Send email notification to client
    // For now, just return the updated document with the public URL

    const publicUrl = `/d/${updated.publicToken}`;

    return NextResponse.json({
      ...updated,
      publicUrl,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error sending document:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
