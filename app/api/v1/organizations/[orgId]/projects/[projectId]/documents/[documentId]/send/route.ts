import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documents, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { logActivity } from "@/lib/activity";
import { sendEmail, getProjectRecipients } from "@/lib/email/send";
import {
  proposalReadyEmail,
  agreementReadyEmail,
  documentSharedEmail,
} from "@/lib/email/lifecycle-emails";

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
    const body = await request.json().catch(() => ({}));
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

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const publicUrl = `/d/${updated.publicToken}`;
    const fullPublicUrl = `${baseUrl}${publicUrl}`;

    // Send email notification to project recipients
    const recipientEmail = body?.recipientEmail;

    // Use provided email or fall back to project invitation recipients
    const recipients = recipientEmail
      ? [recipientEmail]
      : await getProjectRecipients(projectId);

    if (recipients.length > 0) {
      const emailCtx = {
        organizationName: organization.name,
        clientName: project.client.name,
        projectName: project.name,
        workspaceUrl: fullPublicUrl,
      };

      let emailData;
      if (document.type === "proposal") {
        emailData = proposalReadyEmail(emailCtx);
      } else if (document.type === "contract") {
        emailData = agreementReadyEmail(emailCtx);
      } else {
        emailData = documentSharedEmail({
          ...emailCtx,
          documentTitle: document.title,
          documentType: document.type,
        });
      }

      // Send to each recipient (fire and forget — don't block response)
      for (const email of recipients) {
        sendEmail(
          {
            to: email,
            subject: emailData.subject,
            react: emailData.react,
            from: `${organization.name} <${process.env.EMAIL_FROM || "noreply@usescope.net"}>`,
          },
          {
            organizationId: orgId,
            entityType: "document",
            entityId: documentId,
          }
        ).catch((err) =>
          console.error("Failed to send document email:", err)
        );
      }
    }

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
