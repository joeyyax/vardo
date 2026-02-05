import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq, and, desc, sql } from "drizzle-orm";

// GET /api/v1/notifications
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const userId = session.user.id;

    const searchParams = request.nextUrl.searchParams;
    const unreadOnly = searchParams.get("unreadOnly") === "true";
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);
    const offset = parseInt(searchParams.get("offset") || "0");

    // Build conditions
    const conditions = [eq(notifications.userId, userId)];
    if (unreadOnly) {
      conditions.push(eq(notifications.isRead, false));
    }

    const notificationList = await db.query.notifications.findMany({
      where: and(...conditions),
      with: {
        task: {
          columns: { id: true, name: true, projectId: true },
        },
        actor: {
          columns: { id: true, name: true, email: true, image: true },
        },
      },
      orderBy: [desc(notifications.createdAt)],
      limit,
      offset,
    });

    // Get counts
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(notifications)
      .where(eq(notifications.userId, userId));

    const [{ unread }] = await db
      .select({ unread: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

    return NextResponse.json({
      notifications: notificationList,
      unreadCount: Number(unread),
      pagination: {
        total: Number(total),
        limit,
        offset,
        hasMore: offset + notificationList.length < Number(total),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching notifications:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/notifications - Mark all as read
export async function PATCH(request: NextRequest) {
  try {
    const session = await requireSession();
    const userId = session.user.id;

    await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error marking notifications as read:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
