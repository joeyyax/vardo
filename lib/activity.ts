import { db } from "@/lib/db";
import {
  projectActivities,
  type ActivityType,
  type ActorType,
  type ActivityMetadata,
} from "@/lib/db/schema";

/**
 * Log an activity to the project activity log.
 * This is a helper function that can be called from anywhere in the codebase.
 */
export async function logActivity({
  projectId,
  type,
  actorId,
  actorType = "user",
  content,
  metadata = {},
  isPublic = false,
}: {
  projectId: string;
  type: ActivityType;
  actorId?: string | null;
  actorType?: ActorType;
  content?: string | null;
  metadata?: ActivityMetadata;
  isPublic?: boolean;
}) {
  try {
    const [activity] = await db
      .insert(projectActivities)
      .values({
        projectId,
        type,
        actorId: actorId ?? null,
        actorType,
        content,
        metadata,
        isPublic,
      })
      .returning();

    return activity;
  } catch (error) {
    console.error("Failed to log activity:", error);
    // Don't throw - activity logging should not break the main operation
    return null;
  }
}

/**
 * Log a stage change activity.
 */
export async function logStageChange({
  projectId,
  actorId,
  fromStage,
  toStage,
}: {
  projectId: string;
  actorId: string;
  fromStage: string | null;
  toStage: string;
}) {
  return logActivity({
    projectId,
    type: "stage_change",
    actorId,
    metadata: {
      fromStage: fromStage ?? undefined,
      toStage,
    },
    isPublic: true, // Stage changes are visible to clients
  });
}

/**
 * Log a task creation activity.
 */
export async function logTaskCreated({
  projectId,
  actorId,
  taskId,
  taskName,
}: {
  projectId: string;
  actorId: string;
  taskId: string;
  taskName: string;
}) {
  return logActivity({
    projectId,
    type: "task_created",
    actorId,
    metadata: {
      taskId,
      taskName,
    },
    isPublic: true,
  });
}

/**
 * Log a task status change activity.
 */
export async function logTaskStatusChanged({
  projectId,
  actorId,
  taskId,
  taskName,
  fromStatus,
  toStatus,
}: {
  projectId: string;
  actorId: string;
  taskId: string;
  taskName: string;
  fromStatus: string | null;
  toStatus: string | null;
}) {
  // Determine if this is a completion or just a status change
  const type = toStatus === "done" ? "task_completed" : "task_status_changed";

  return logActivity({
    projectId,
    type,
    actorId,
    metadata: {
      taskId,
      taskName,
      fromStatus: fromStatus ?? undefined,
      toStatus: toStatus ?? undefined,
    },
    isPublic: true,
  });
}

/**
 * Log a file upload activity.
 */
export async function logFileUploaded({
  projectId,
  actorId,
  fileId,
  fileName,
  fileSize,
}: {
  projectId: string;
  actorId: string;
  fileId: string;
  fileName: string;
  fileSize: number;
}) {
  return logActivity({
    projectId,
    type: "file_uploaded",
    actorId,
    metadata: {
      fileId,
      fileName,
      fileSize,
    },
    isPublic: true,
  });
}

/**
 * Log a file deletion activity.
 */
export async function logFileDeleted({
  projectId,
  actorId,
  fileId,
  fileName,
}: {
  projectId: string;
  actorId: string;
  fileId: string;
  fileName: string;
}) {
  return logActivity({
    projectId,
    type: "file_deleted",
    actorId,
    metadata: {
      fileId,
      fileName,
    },
    isPublic: false, // Deletions are internal
  });
}

/**
 * Log an invitation sent activity.
 */
export async function logInvitationSent({
  projectId,
  actorId,
  invitationId,
  inviteeEmail,
  inviteeRole,
}: {
  projectId: string;
  actorId: string;
  invitationId: string;
  inviteeEmail: string;
  inviteeRole: string;
}) {
  return logActivity({
    projectId,
    type: "invitation_sent",
    actorId,
    metadata: {
      invitationId,
      inviteeEmail,
      inviteeRole,
    },
    isPublic: false, // Invitations are internal
  });
}

/**
 * Log an invitation accepted activity.
 */
export async function logInvitationAccepted({
  projectId,
  actorId,
  invitationId,
  inviteeEmail,
}: {
  projectId: string;
  actorId: string;
  invitationId: string;
  inviteeEmail: string;
}) {
  return logActivity({
    projectId,
    type: "invitation_accepted",
    actorId,
    actorType: "client",
    metadata: {
      invitationId,
      inviteeEmail,
    },
    isPublic: true, // Client joining is visible
  });
}
