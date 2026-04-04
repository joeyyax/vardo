// ---------------------------------------------------------------------------
// Toast inbox — CRUD for persistent toasts stored in DB
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { userNotifications } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";

/** Get unread, undismissed notifications for a user. */
export async function getUnread(userId: string) {
  return db.query.userNotifications.findMany({
    where: and(
      eq(userNotifications.userId, userId),
      isNull(userNotifications.dismissedAt),
    ),
    orderBy: (n, { desc }) => [desc(n.createdAt)],
    limit: 50,
  });
}

/** Mark a notification as read. */
export async function markRead(userId: string, notificationId: string) {
  await db
    .update(userNotifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(userNotifications.id, notificationId),
        eq(userNotifications.userId, userId),
      ),
    );
}

/** Dismiss a notification (removes it from the inbox). */
export async function dismiss(userId: string, notificationId: string) {
  await db
    .update(userNotifications)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(userNotifications.id, notificationId),
        eq(userNotifications.userId, userId),
      ),
    );
}

/** Dismiss all notifications for a user. */
export async function dismissAll(userId: string) {
  await db
    .update(userNotifications)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(userNotifications.userId, userId),
        isNull(userNotifications.dismissedAt),
      ),
    );
}
