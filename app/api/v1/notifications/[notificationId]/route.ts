import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ notificationId: string }>;
};

// PATCH /api/v1/notifications/[notificationId] - Mark as read
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { notificationId } = await params;
    const session = await requireSession();
    const userId = session.user.id;

    const body = await request.json();
    const { isRead } = body;

    // Verify notification belongs to user
    const notification = await db.query.notifications.findFirst({
      where: and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId)
      ),
    });

    if (!notification) {
      return NextResponse.json({ error: "Notification not found" }, { status: 404 });
    }

    const [updated] = await db
      .update(notifications)
      .set({ isRead: isRead ?? true })
      .where(eq(notifications.id, notificationId))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating notification:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/notifications/[notificationId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { notificationId } = await params;
    const session = await requireSession();
    const userId = session.user.id;

    // Verify notification belongs to user
    const notification = await db.query.notifications.findFirst({
      where: and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId)
      ),
    });

    if (!notification) {
      return NextResponse.json({ error: "Notification not found" }, { status: 404 });
    }

    await db.delete(notifications).where(eq(notifications.id, notificationId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting notification:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
