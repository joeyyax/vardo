import { db } from "@/lib/db";
import {
  notifications,
  notificationPreferences,
  taskWatchers,
  projectWatchers,
  expenseWatchers,
  users,
  tasks,
  type NotificationType,
} from "@/lib/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { NotificationEmail } from "@/lib/email/templates/notification";

type CreateNotificationParams = {
  userId: string;
  type: NotificationType;
  taskId?: string;
  actorId?: string;
  content: string;
};

/**
 * Create a notification for a user.
 */
export async function createNotification(params: CreateNotificationParams) {
  const { userId, type, taskId, actorId, content } = params;

  try {
    // Check user's notification preferences
    const prefs = await db.query.notificationPreferences.findFirst({
      where: eq(notificationPreferences.userId, userId),
    });

    // If no preferences exist, notifications are enabled by default
    // Check if this notification type is enabled
    if (prefs) {
      const typeToPreference: Partial<Record<NotificationType, keyof typeof prefs>> = {
        assigned: "assignedToYou",
        mentioned: "mentioned",
        comment: "watchedTaskChanged",
        status_changed: "watchedTaskChanged",
        blocker_resolved: "blockerResolved",
        client_comment: "clientComment",
        // edit_requested: always delivered (no preference toggle)
      };

      const prefKey = typeToPreference[type];
      if (prefKey && prefs[prefKey] === false) {
        return null; // User has disabled this notification type
      }
    }

    const [notification] = await db
      .insert(notifications)
      .values({
        userId,
        type,
        taskId: taskId || null,
        actorId: actorId || null,
        content,
      })
      .returning();

    // Send email notification (fire-and-forget)
    if (notification) {
      sendNotificationEmail({
        notificationId: notification.id,
        userId,
        type,
        content,
        taskId,
      }).catch((err) => console.error("Error sending notification email:", err));
    }

    return notification;
  } catch (error) {
    console.error("Error creating notification:", error);
    return null;
  }
}

/**
 * Notify all watchers of a task about an event.
 * Excludes the actor from receiving the notification.
 */
export async function notifyTaskWatchers(params: {
  taskId: string;
  actorId: string;
  type: NotificationType;
  content: string;
}) {
  const { taskId, actorId, type, content } = params;

  try {
    // Get all watchers except the actor
    const watchers = await db.query.taskWatchers.findMany({
      where: and(
        eq(taskWatchers.taskId, taskId),
        ne(taskWatchers.userId, actorId)
      ),
    });

    // Create notifications for each watcher
    const notifications = await Promise.all(
      watchers.map((watcher) =>
        createNotification({
          userId: watcher.userId,
          type,
          taskId,
          actorId,
          content,
        })
      )
    );

    return notifications.filter(Boolean);
  } catch (error) {
    console.error("Error notifying watchers:", error);
    return [];
  }
}

/**
 * Notify a specific user about being assigned to a task.
 * Creates in-app notification and sends email if enabled.
 */
export async function notifyAssignment(params: {
  assigneeId: string;
  actorId: string;
  taskId: string;
  taskName: string;
  actorName: string;
}) {
  const { assigneeId, actorId, taskId, taskName, actorName } = params;

  // Don't notify if assigning to self
  if (assigneeId === actorId) return null;

  const notification = await createNotification({
    userId: assigneeId,
    type: "assigned",
    taskId,
    actorId,
    content: `${actorName} assigned you to "${taskName}"`,
  });

  return notification;
}

/**
 * Send notification email to a user. Fire-and-forget.
 */
async function sendNotificationEmail(params: {
  notificationId: string;
  userId: string;
  type: NotificationType;
  content: string;
  taskId?: string;
}) {
  if (!isEmailConfigured()) return;

  const { notificationId, userId, type, content, taskId } = params;

  // Check if user has email notifications enabled
  const prefs = await db.query.notificationPreferences.findFirst({
    where: eq(notificationPreferences.userId, userId),
  });
  if (prefs?.emailEnabled === false) return;

  // Get user email
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { email: true },
  });
  if (!user?.email) return;

  // Build action URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  let actionUrl = baseUrl;
  if (taskId) {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { projectId: true },
    });
    if (task) {
      actionUrl = `${baseUrl}/projects/${task.projectId}?task=${taskId}`;
    }
  }

  // Subject line by type
  const subjectMap: Record<string, string> = {
    assigned: "You were assigned to a task",
    comment: "New comment on a task",
    status_changed: "Task status changed",
    blocker_resolved: "Blocker resolved",
    client_comment: "Client commented on a task",
    mentioned: "You were mentioned",
    edit_requested: "Edit requested",
  };
  const subject = subjectMap[type] || "New notification";

  // Heading by type
  const headingMap: Record<string, string> = {
    assigned: "Task assigned to you",
    comment: "New comment",
    status_changed: "Status changed",
    blocker_resolved: "Blocker resolved",
    client_comment: "Client comment",
    mentioned: "You were mentioned",
    edit_requested: "Edit requested",
  };
  const emailHeading = headingMap[type] || "Notification";

  await sendEmail({
    to: user.email,
    subject,
    react: NotificationEmail({
      heading: emailHeading,
      content,
      actionUrl,
    }),
  });

  // Mark notification as email sent
  await db
    .update(notifications)
    .set({ emailSent: true })
    .where(eq(notifications.id, notificationId));
}

/**
 * Notify watchers about a status change.
 */
export async function notifyStatusChange(params: {
  taskId: string;
  taskName: string;
  actorId: string;
  actorName: string;
  fromStatus: string | null;
  toStatus: string | null;
}) {
  const { taskId, taskName, actorId, actorName, fromStatus, toStatus } = params;

  const statusLabels: Record<string, string> = {
    todo: "To Do",
    in_progress: "In Progress",
    review: "Review",
    done: "Done",
  };

  const toLabel = toStatus ? statusLabels[toStatus] || toStatus : "category";
  const content = `${actorName} changed "${taskName}" to ${toLabel}`;

  return notifyTaskWatchers({
    taskId,
    actorId,
    type: "status_changed",
    content,
  });
}

/**
 * Notify watchers about a new comment.
 */
export async function notifyComment(params: {
  taskId: string;
  taskName: string;
  actorId: string;
  actorName: string;
  isShared: boolean;
}) {
  const { taskId, taskName, actorId, actorName, isShared } = params;

  const content = `${actorName} commented on "${taskName}"`;

  return notifyTaskWatchers({
    taskId,
    actorId,
    type: isShared ? "client_comment" : "comment",
    content,
  });
}

/**
 * Notify watchers when a blocker is resolved.
 */
export async function notifyBlockerResolved(params: {
  taskId: string;
  taskName: string;
  blockerName: string;
  actorId: string;
  actorName: string;
}) {
  const { taskId, taskName, blockerName, actorId, actorName } = params;

  const content = `Blocker "${blockerName}" was resolved for "${taskName}"`;

  return notifyTaskWatchers({
    taskId,
    actorId,
    type: "blocker_resolved",
    content,
  });
}

/**
 * Notify all watchers of an expense about a comment.
 * Excludes the actor from receiving the notification.
 */
export async function notifyExpenseWatchers(params: {
  expenseId: string;
  actorId: string;
  actorName: string;
  isShared: boolean;
}) {
  const { expenseId, actorId, actorName, isShared } = params;

  try {
    // Get all watchers except the actor
    const watchers = await db.query.expenseWatchers.findMany({
      where: and(
        eq(expenseWatchers.expenseId, expenseId),
        ne(expenseWatchers.userId, actorId)
      ),
    });

    // Create notifications for each watcher
    const content = `${actorName} commented on an expense`;
    const notifications = await Promise.all(
      watchers.map((watcher) =>
        createNotification({
          userId: watcher.userId,
          type: isShared ? "client_comment" : "comment",
          actorId,
          content,
        })
      )
    );

    return notifications.filter(Boolean);
  } catch (error) {
    console.error("Error notifying expense watchers:", error);
    return [];
  }
}

/**
 * Ensure a user is watching an entity. Inserts a watcher row if one doesn't
 * already exist. Silently succeeds if the user is already watching.
 * Never throws — logs errors and returns void.
 */
export async function ensureWatcher(
  entityType: "task" | "project" | "expense",
  entityId: string,
  userId: string,
  reason: string
) {
  try {
    switch (entityType) {
      case "task": {
        const existing = await db.query.taskWatchers.findFirst({
          where: and(
            eq(taskWatchers.taskId, entityId),
            eq(taskWatchers.userId, userId)
          ),
        });
        if (!existing) {
          await db.insert(taskWatchers).values({
            taskId: entityId,
            userId,
            reason,
          });
        }
        break;
      }
      case "project": {
        const existing = await db.query.projectWatchers.findFirst({
          where: and(
            eq(projectWatchers.projectId, entityId),
            eq(projectWatchers.userId, userId)
          ),
        });
        if (!existing) {
          await db.insert(projectWatchers).values({
            projectId: entityId,
            userId,
            reason,
          });
        }
        break;
      }
      case "expense": {
        const existing = await db.query.expenseWatchers.findFirst({
          where: and(
            eq(expenseWatchers.expenseId, entityId),
            eq(expenseWatchers.userId, userId)
          ),
        });
        if (!existing) {
          await db.insert(expenseWatchers).values({
            expenseId: entityId,
            userId,
            reason,
          });
        }
        break;
      }
    }
  } catch (error) {
    console.error(`Error ensuring ${entityType} watcher:`, error);
  }
}
