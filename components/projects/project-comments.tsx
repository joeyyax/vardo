"use client";

import { useCallback } from "react";
import {
  EntityComments,
  type ActivityEntry,
} from "@/components/ui/entity-comments";
import { eventBus } from "@/lib/events";
import { FolderOpen, User, Archive } from "lucide-react";

const FIELD_ICONS: Record<string, React.ReactNode> = {
  name: <FolderOpen className="size-3 text-muted-foreground" />,
  assignee: <User className="size-3 text-muted-foreground" />,
  archived: <Archive className="size-3 text-muted-foreground" />,
};

function formatFieldChange(activity: ActivityEntry): React.ReactNode {
  const actorName =
    activity.actorName || activity.actorEmail?.split("@")[0] || "Someone";
  const field = activity.field || "this project";

  const oldVal = activity.oldValue || "none";
  const newVal = activity.newValue || "none";
  return (
    <>
      <span className="font-medium">{actorName}</span> changed {field} from{" "}
      &ldquo;{oldVal}&rdquo; to &ldquo;{newVal}&rdquo;
    </>
  );
}

type ProjectCommentsProps = {
  orgId: string;
  projectId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function ProjectComments({
  orgId,
  projectId,
  currentUserId,
  onUpdate,
}: ProjectCommentsProps) {
  const subscribeToEvents = useCallback(
    (fetchData: () => void) => [
      eventBus.on("project:comment:created", (e) => {
        if (e.projectId === projectId) fetchData();
      }),
      eventBus.on("project:comment:updated", (e) => {
        if (e.projectId === projectId) fetchData();
      }),
      eventBus.on("project:comment:deleted", (e) => {
        if (e.projectId === projectId) fetchData();
      }),
    ],
    [projectId]
  );

  return (
    <EntityComments
      orgId={orgId}
      entityId={projectId}
      currentUserId={currentUserId}
      onUpdate={onUpdate}
      apiBasePath={`/api/v1/organizations/${orgId}/projects/${projectId}`}
      fieldIcons={FIELD_ICONS}
      formatFieldChange={formatFieldChange}
      subscribeToEvents={subscribeToEvents}
      onCommentCreated={() =>
        eventBus.emit("project:comment:created", { projectId })
      }
      onCommentUpdated={(commentId) =>
        eventBus.emit("project:comment:updated", { projectId, commentId })
      }
      onCommentDeleted={(commentId) =>
        eventBus.emit("project:comment:deleted", { projectId, commentId })
      }
    />
  );
}
