import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import {
  getLockStatus,
  isLockExpired,
  transferLock,
  publishEditRequest,
  publishLockTransfer,
} from "@/lib/document-locks";
import { createNotification } from "@/lib/notifications";
import { db } from "@/lib/db";
import { documents, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; documentId: string }>;
};

// POST — request edit access from the current lock holder
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, documentId } = await params;
    const { organization, session } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify the document exists
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { client: true },
    });
    if (!project || project.client.organizationId !== orgId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const doc = await db.query.documents.findFirst({
      where: eq(documents.id, documentId),
    });
    if (!doc || doc.projectId !== projectId || doc.organizationId !== orgId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const lock = await getLockStatus(documentId);
    if (!lock) {
      return NextResponse.json({ error: "Document is not locked" }, { status: 400 });
    }

    if (lock.userId === session.user.id) {
      return NextResponse.json({ error: "You already hold the lock" }, { status: 400 });
    }

    const requesterName = session.user.name || session.user.email || "Unknown";

    // If the lock holder is idle (>20 min), auto-transfer
    if (isLockExpired(lock)) {
      const transferred = await transferLock(
        documentId,
        lock.userId,
        session.user.id,
        requesterName
      );

      if (transferred) {
        await publishLockTransfer(documentId, session.user.id, requesterName);
        return NextResponse.json({ transferred: true });
      }

      return NextResponse.json({ error: "Failed to transfer lock" }, { status: 500 });
    }

    // Lock holder is active — send them a request
    await publishEditRequest(documentId, session.user.id, requesterName);

    // Also create an in-app notification
    await createNotification({
      userId: lock.userId,
      type: "edit_requested",
      content: `${requesterName} is requesting edit access to "${doc.title}"`,
    });

    return NextResponse.json({ requested: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error requesting edit access:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
