"use client";

import { useCallback } from "react";
import {
  EntityComments,
  type ActivityEntry,
} from "@/components/ui/entity-comments";
import { eventBus } from "@/lib/events";
import { FileText, User, Archive } from "lucide-react";

const FIELD_ICONS: Record<string, React.ReactNode> = {
  name: <FileText className="size-3 text-muted-foreground" />,
  assignee: <User className="size-3 text-muted-foreground" />,
  archived: <Archive className="size-3 text-muted-foreground" />,
};

function formatFieldChange(activity: ActivityEntry): React.ReactNode {
  const actorName =
    activity.actorName || activity.actorEmail?.split("@")[0] || "Someone";
  const field = activity.field || "this document";

  const oldVal = activity.oldValue || "none";
  const newVal = activity.newValue || "none";
  return (
    <>
      <span className="font-medium">{actorName}</span> changed {field} from{" "}
      &ldquo;{oldVal}&rdquo; to &ldquo;{newVal}&rdquo;
    </>
  );
}

type DocumentCommentsProps = {
  orgId: string;
  documentId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function DocumentComments({
  orgId,
  documentId,
  currentUserId,
  onUpdate,
}: DocumentCommentsProps) {
  const subscribeToEvents = useCallback(
    (fetchData: () => void) => [
      eventBus.on("document:comment:created", (e) => {
        if (e.documentId === documentId) fetchData();
      }),
      eventBus.on("document:comment:updated", (e) => {
        if (e.documentId === documentId) fetchData();
      }),
      eventBus.on("document:comment:deleted", (e) => {
        if (e.documentId === documentId) fetchData();
      }),
    ],
    [documentId]
  );

  return (
    <EntityComments
      orgId={orgId}
      entityId={documentId}
      currentUserId={currentUserId}
      onUpdate={onUpdate}
      apiBasePath={`/api/v1/organizations/${orgId}/documents/${documentId}`}
      fieldIcons={FIELD_ICONS}
      formatFieldChange={formatFieldChange}
      subscribeToEvents={subscribeToEvents}
      onCommentCreated={() =>
        eventBus.emit("document:comment:created", { documentId })
      }
      onCommentUpdated={(commentId) =>
        eventBus.emit("document:comment:updated", { documentId, commentId })
      }
      onCommentDeleted={(commentId) =>
        eventBus.emit("document:comment:deleted", { documentId, commentId })
      }
    />
  );
}
