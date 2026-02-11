import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documents, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { logActivity } from "@/lib/activity";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; documentId: string }>;
};

// Allowed manual status transitions
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["sent"],
  sent: ["accepted", "declined"],
  viewed: ["accepted", "declined"],
  declined: ["draft"],
};

/**
 * POST /api/v1/organizations/[orgId]/projects/[projectId]/documents/[documentId]/status
 * Manually transition a document's status (no email sent).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, documentId } = await params;
    const { organization, session } = await requireOrg();

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

    const body = await request.json();
    const { status, reason } = body as { status: string; reason?: string };

    if (!status) {
      return NextResponse.json({ error: "Status is required" }, { status: 400 });
    }

    // Validate transition
    const allowed = ALLOWED_TRANSITIONS[document.status] || [];
    if (!allowed.includes(status)) {
      return NextResponse.json(
        {
          error: `Cannot transition from "${document.status}" to "${status}"`,
        },
        { status: 400 }
      );
    }

    // Build update payload based on target status
    const now = new Date();
    const updateData: Record<string, unknown> = {
      status,
      updatedAt: now,
    };

    switch (status) {
      case "sent":
        updateData.sentAt = now;
        break;
      case "accepted":
        updateData.acceptedAt = now;
        updateData.acceptedBy = session.user.email;
        break;
      case "declined":
        updateData.declinedAt = now;
        updateData.declinedBy = session.user.email;
        if (reason) {
          updateData.declineReason = reason;
        }
        break;
      case "draft":
        // Revert from declined → draft: clear all sent/response timestamps
        updateData.sentAt = null;
        updateData.viewedAt = null;
        updateData.declinedAt = null;
        updateData.declinedBy = null;
        updateData.declineReason = null;
        break;
    }

    const [updated] = await db
      .update(documents)
      .set(updateData)
      .where(eq(documents.id, documentId))
      .returning();

    // Log activity
    const activityType =
      status === "sent"
        ? "document_sent"
        : status === "accepted"
          ? "document_accepted"
          : status === "declined"
            ? "document_declined"
            : null;

    if (activityType) {
      await logActivity({
        projectId,
        type: activityType,
        actorId: session.user.id,
        metadata: {
          documentId,
          documentTitle: document.title,
          documentType: document.type,
          ...(reason ? { declineReason: reason } : {}),
        },
        isPublic: true,
      });
    }

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error updating document status:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
