"use client";

import { useCallback } from "react";
import {
  EntityComments,
  type ActivityEntry,
} from "@/components/ui/entity-comments";
import { eventBus } from "@/lib/events";
import { Building2, User, Archive } from "lucide-react";

const FIELD_ICONS: Record<string, React.ReactNode> = {
  name: <Building2 className="size-3 text-muted-foreground" />,
  assignee: <User className="size-3 text-muted-foreground" />,
  archived: <Archive className="size-3 text-muted-foreground" />,
};

function formatFieldChange(activity: ActivityEntry): React.ReactNode {
  const actorName =
    activity.actorName || activity.actorEmail?.split("@")[0] || "Someone";
  const field = activity.field || "this client";

  const oldVal = activity.oldValue || "none";
  const newVal = activity.newValue || "none";
  return (
    <>
      <span className="font-medium">{actorName}</span> changed {field} from{" "}
      &ldquo;{oldVal}&rdquo; to &ldquo;{newVal}&rdquo;
    </>
  );
}

type ClientCommentsProps = {
  orgId: string;
  clientId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function ClientComments({
  orgId,
  clientId,
  currentUserId,
  onUpdate,
}: ClientCommentsProps) {
  const subscribeToEvents = useCallback(
    (fetchData: () => void) => [
      eventBus.on("client:comment:created", (e) => {
        if (e.clientId === clientId) fetchData();
      }),
      eventBus.on("client:comment:updated", (e) => {
        if (e.clientId === clientId) fetchData();
      }),
      eventBus.on("client:comment:deleted", (e) => {
        if (e.clientId === clientId) fetchData();
      }),
    ],
    [clientId]
  );

  return (
    <EntityComments
      orgId={orgId}
      entityId={clientId}
      currentUserId={currentUserId}
      onUpdate={onUpdate}
      apiBasePath={`/api/v1/organizations/${orgId}/clients/${clientId}`}
      fieldIcons={FIELD_ICONS}
      formatFieldChange={formatFieldChange}
      subscribeToEvents={subscribeToEvents}
      onCommentCreated={() =>
        eventBus.emit("client:comment:created", { clientId })
      }
      onCommentUpdated={(commentId) =>
        eventBus.emit("client:comment:updated", { clientId, commentId })
      }
      onCommentDeleted={(commentId) =>
        eventBus.emit("client:comment:deleted", { clientId, commentId })
      }
    />
  );
}
