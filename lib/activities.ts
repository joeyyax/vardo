import { db } from "@/lib/db";
import { activities, emailSends, type ActivityAction, type ActivityEntityType, type EmailSendEntityType, ACTIVITY_ACTIONS } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type LogActivityParams = {
  organizationId: string;
  actorId: string;
  action: ActivityAction;
  entityType: ActivityEntityType;
  entityId: string;
  metadata?: Record<string, unknown>;
  isClientVisible?: boolean;
  // Context
  projectId?: string;
  taskId?: string;
};

/**
 * Log an activity to the global activity log.
 */
export async function logActivity(params: LogActivityParams) {
  const {
    organizationId,
    actorId,
    action,
    entityType,
    entityId,
    metadata,
    isClientVisible = false,
    projectId,
    taskId,
  } = params;

  // Validate action
  if (!ACTIVITY_ACTIONS.includes(action)) {
    console.warn(`Invalid activity action: ${action}`);
    return null;
  }

  try {
    const [activity] = await db
      .insert(activities)
      .values({
        organizationId,
        actorId,
        action,
        entityType,
        entityId,
        metadata: metadata || {},
        isClientVisible,
        projectId: projectId || null,
        taskId: taskId || null,
      })
      .returning();

    return activity;
  } catch (error) {
    console.error("Error logging activity:", error);
    return null;
  }
}

// Helper functions for common activities

export async function logTaskCreated(params: {
  organizationId: string;
  actorId: string;
  projectId: string;
  taskId: string;
  taskName: string;
  isClientVisible?: boolean;
}) {
  return logActivity({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "created",
    entityType: "task",
    entityId: params.taskId,
    projectId: params.projectId,
    taskId: params.taskId,
    metadata: {
      taskName: params.taskName,
    },
    isClientVisible: params.isClientVisible,
  });
}

export async function logTaskStatusChanged(params: {
  organizationId: string;
  actorId: string;
  projectId: string;
  taskId: string;
  taskName: string;
  fromStatus: string | null;
  toStatus: string | null;
  isClientVisible?: boolean;
}) {
  return logActivity({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "status_changed",
    entityType: "task",
    entityId: params.taskId,
    projectId: params.projectId,
    taskId: params.taskId,
    metadata: {
      taskName: params.taskName,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
    },
    isClientVisible: params.isClientVisible,
  });
}

export async function logTaskAssigned(params: {
  organizationId: string;
  actorId: string;
  projectId: string;
  taskId: string;
  taskName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  isClientVisible?: boolean;
}) {
  return logActivity({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: params.assigneeId ? "assigned" : "unassigned",
    entityType: "task",
    entityId: params.taskId,
    projectId: params.projectId,
    taskId: params.taskId,
    metadata: {
      taskName: params.taskName,
      assigneeId: params.assigneeId,
      assigneeName: params.assigneeName,
    },
    isClientVisible: params.isClientVisible,
  });
}

export async function logCommentAdded(params: {
  organizationId: string;
  actorId: string;
  projectId?: string;
  taskId?: string;
  taskName?: string;
  expenseId?: string;
  commentId: string;
  isShared: boolean;
  isClientVisible?: boolean;
}) {
  // Determine entity type based on what's provided
  const entityType = params.taskId ? "task" : params.expenseId ? "expense" : "project";
  const entityId = params.taskId || params.expenseId || params.projectId || "";

  return logActivity({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "commented",
    entityType,
    entityId,
    projectId: params.projectId,
    taskId: params.taskId,
    metadata: {
      taskName: params.taskName,
      commentId: params.commentId,
      isShared: params.isShared,
    },
    // Comment activities are only visible to clients if the comment is shared
    isClientVisible: params.isShared && (params.isClientVisible ?? true),
  });
}

export async function logFileUploaded(params: {
  organizationId: string;
  actorId: string;
  projectId: string;
  fileId: string;
  fileName: string;
  taskId?: string;
  isClientVisible?: boolean;
}) {
  return logActivity({
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: "file_attached",
    entityType: params.taskId ? "task" : "project",
    entityId: params.taskId || params.projectId,
    projectId: params.projectId,
    taskId: params.taskId,
    metadata: {
      fileName: params.fileName,
      fileId: params.fileId,
    },
    isClientVisible: params.isClientVisible,
  });
}

// Map email send entity types to activity entity types
const EMAIL_ENTITY_TO_ACTIVITY_ENTITY: Record<EmailSendEntityType, ActivityEntityType> = {
  invitation: "contact",
  invoice: "invoice",
  document: "document",
  notification: "task",
  lifecycle: "project",
};

/**
 * Log an email delivery event as an activity.
 * Called by the delivery webhook when email status changes.
 */
export async function logEmailEvent(params: {
  emailSendId: string;
  action: "email_sent" | "email_delivered" | "email_bounced" | "email_opened" | "email_clicked";
  recipientEmail: string;
  organizationId: string;
  entityType: EmailSendEntityType;
  entityId: string;
}) {
  const activityEntityType = EMAIL_ENTITY_TO_ACTIVITY_ENTITY[params.entityType] || "project";

  return logActivity({
    organizationId: params.organizationId,
    actorId: "system",
    action: params.action,
    entityType: activityEntityType,
    entityId: params.entityId,
    metadata: {
      emailSendId: params.emailSendId,
      recipientEmail: params.recipientEmail,
      emailEntityType: params.entityType,
    },
    isClientVisible: false,
  });
}
