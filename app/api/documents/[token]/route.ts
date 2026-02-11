import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  checkPublicRateLimit,
  isValidToken,
  logSecurityEvent,
} from "@/lib/security";
import { logActivity } from "@/lib/activity";
import { handleDocumentAcceptance } from "@/lib/agreement-generator";

type RouteParams = {
  params: Promise<{ token: string }>;
};

// GET /api/documents/[token]
// Public endpoint to view document details
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { token } = await params;

    // Validate token format
    if (!isValidToken(token)) {
      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    // Rate limiting
    const rateLimit = await checkPublicRateLimit();
    if (!rateLimit.allowed) {
      await logSecurityEvent("rate_limit_exceeded", { endpoint: "document_view", token: token.slice(0, 8) });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const document = await db.query.documents.findFirst({
      where: eq(documents.publicToken, token),
      with: {
        project: {
          columns: {
            id: true,
            name: true,
          },
          with: {
            client: {
              columns: {
                id: true,
                name: true,
              },
              with: {
                organization: {
                  columns: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        createdByUser: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // Can't view draft documents
    if (document.status === "draft") {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // Mark as viewed if not already
    if (!document.viewedAt && document.status === "sent") {
      await db
        .update(documents)
        .set({
          status: "viewed",
          viewedAt: new Date(),
        })
        .where(eq(documents.id, document.id));
    }

    // Return document info (don't expose internal IDs)
    return NextResponse.json({
      id: document.id,
      type: document.type,
      status: document.status,
      title: document.title,
      content: document.content,
      requiresContract: document.requiresContract,
      sentAt: document.sentAt,
      viewedAt: document.viewedAt,
      acceptedAt: document.acceptedAt,
      declinedAt: document.declinedAt,
      project: {
        name: document.project.name,
      },
      organization: {
        name: document.project.client.organization.name,
      },
      createdBy: document.createdByUser ? {
        name: document.createdByUser.name,
        email: document.createdByUser.email,
      } : null,
    });
  } catch (error) {
    console.error("Error fetching document:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/documents/[token]
// Accept or decline the document
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { token } = await params;

    // Validate token format
    if (!isValidToken(token)) {
      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    // Stricter rate limiting for actions (5 per minute)
    const rateLimit = await checkPublicRateLimit();
    if (!rateLimit.allowed) {
      await logSecurityEvent("rate_limit_exceeded", { endpoint: "document_action", token: token.slice(0, 8) });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const document = await db.query.documents.findFirst({
      where: eq(documents.publicToken, token),
      with: {
        project: {
          with: {
            client: {
              columns: { organizationId: true },
            },
          },
        },
      },
    });

    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // Can't interact with draft documents
    if (document.status === "draft") {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // Can't re-accept or re-decline
    if (document.status === "accepted" || document.status === "declined") {
      return NextResponse.json(
        { error: `Document has already been ${document.status}` },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { action, email, reason } = body;

    // Validate action
    if (!action || !["accept", "decline"].includes(action)) {
      return NextResponse.json(
        { error: "Action must be 'accept' or 'decline'" },
        { status: 400 }
      );
    }

    // Validate email
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json(
        { error: "Valid email is required" },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    if (action === "accept") {
      // Update document to accepted
      const [updated] = await db
        .update(documents)
        .set({
          status: "accepted",
          acceptedAt: new Date(),
          acceptedBy: normalizedEmail,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, document.id))
        .returning();

      // Log activity
      await logActivity({
        projectId: document.projectId,
        type: "document_accepted",
        actorType: "client",
        metadata: {
          documentId: document.id,
          documentTitle: document.title,
          documentType: document.type,
        },
        isPublic: true,
      });

      // Security audit log
      await logSecurityEvent("document_accepted", {
        documentId: document.id,
        documentType: document.type,
        acceptedBy: normalizedEmail,
      });

      // Trigger lifecycle stage transition
      try {
        await handleDocumentAcceptance(
          document.id,
          document.type as "proposal" | "contract" | "change_order",
          document.projectId,
          document.project.client.organizationId
        );
      } catch (err) {
        // Log but don't fail the acceptance
        console.error("Error handling document acceptance lifecycle:", err);
      }

      return NextResponse.json({
        success: true,
        status: "accepted",
        document: {
          id: updated.id,
          title: updated.title,
          type: updated.type,
          acceptedAt: updated.acceptedAt,
        },
      });
    } else {
      // Update document to declined
      const [updated] = await db
        .update(documents)
        .set({
          status: "declined",
          declinedAt: new Date(),
          declinedBy: normalizedEmail,
          declineReason: reason || null,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, document.id))
        .returning();

      // Log activity (internal only for declines)
      await logActivity({
        projectId: document.projectId,
        type: "document_accepted", // We'll use same type, metadata will distinguish
        actorType: "client",
        content: reason || undefined,
        metadata: {
          documentId: document.id,
          documentTitle: document.title,
          documentType: document.type,
          action: "declined",
        },
        isPublic: false,
      });

      // Security audit log
      await logSecurityEvent("document_declined", {
        documentId: document.id,
        documentType: document.type,
        declinedBy: normalizedEmail,
        hasReason: !!reason,
      });

      return NextResponse.json({
        success: true,
        status: "declined",
        document: {
          id: updated.id,
          title: updated.title,
          type: updated.type,
          declinedAt: updated.declinedAt,
        },
      });
    }
  } catch (error) {
    console.error("Error processing document action:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
