import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import {
  acquireLock,
  releaseLock,
  heartbeat,
  getLockStatus,
  createRevisionBeforeTransfer,
} from "@/lib/document-locks";
import { db } from "@/lib/db";
import { documents, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; documentId: string }>;
};

async function verifyAccess(orgId: string, projectId: string, documentId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: { client: true },
  });
  if (!project || project.client.organizationId !== orgId) return null;

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!doc || doc.projectId !== projectId || doc.organizationId !== orgId) return null;

  return doc;
}

// POST — acquire lock
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, documentId } = await params;
    const { organization, session } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const doc = await verifyAccess(orgId, projectId, documentId);
    if (!doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const userName = session.user.name || session.user.email || "Unknown";
    const result = await acquireLock(documentId, session.user.id, userName);

    if (result.acquired) {
      return NextResponse.json({ acquired: true });
    }

    return NextResponse.json({
      acquired: false,
      lockedBy: result.lock.userId,
      userName: result.lock.userName,
      lockedAt: result.lock.lockedAt,
      lastActiveAt: result.lock.lastActiveAt,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error acquiring lock:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE — release lock (auto-saves revision)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, documentId } = await params;
    const { organization, session } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const doc = await verifyAccess(orgId, projectId, documentId);
    if (!doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Create a revision before releasing
    const lock = await getLockStatus(documentId);
    if (lock && lock.userId === session.user.id) {
      await createRevisionBeforeTransfer(documentId, session.user.id, "auto_save");
    }

    const released = await releaseLock(documentId, session.user.id);
    return NextResponse.json({ released });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error releasing lock:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH — heartbeat (update lastActiveAt)
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, documentId } = await params;
    const { organization, session } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const updated = await heartbeat(documentId, session.user.id);
    return NextResponse.json({ updated });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating heartbeat:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
