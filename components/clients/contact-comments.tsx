"use client";

import { useCallback } from "react";
import {
  EntityComments,
  type ActivityEntry,
} from "@/components/ui/entity-comments";
import { eventBus } from "@/lib/events";
import { User, Mail, Phone } from "lucide-react";

const FIELD_ICONS: Record<string, React.ReactNode> = {
  name: <User className="size-3 text-muted-foreground" />,
  email: <Mail className="size-3 text-muted-foreground" />,
  phone: <Phone className="size-3 text-muted-foreground" />,
};

function formatFieldChange(activity: ActivityEntry): React.ReactNode {
  const actorName =
    activity.actorName || activity.actorEmail?.split("@")[0] || "Someone";
  const field = activity.field || "this contact";

  const oldVal = activity.oldValue || "none";
  const newVal = activity.newValue || "none";
  return (
    <>
      <span className="font-medium">{actorName}</span> changed {field} from{" "}
      &ldquo;{oldVal}&rdquo; to &ldquo;{newVal}&rdquo;
    </>
  );
}

type ContactCommentsProps = {
  orgId: string;
  clientId: string;
  contactId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function ContactComments({
  orgId,
  clientId,
  contactId,
  currentUserId,
  onUpdate,
}: ContactCommentsProps) {
  const subscribeToEvents = useCallback(
    (fetchData: () => void) => [
      eventBus.on("contact:comment:created", (e) => {
        if (e.contactId === contactId) fetchData();
      }),
      eventBus.on("contact:comment:updated", (e) => {
        if (e.contactId === contactId) fetchData();
      }),
      eventBus.on("contact:comment:deleted", (e) => {
        if (e.contactId === contactId) fetchData();
      }),
    ],
    [contactId]
  );

  return (
    <EntityComments
      orgId={orgId}
      entityId={contactId}
      currentUserId={currentUserId}
      onUpdate={onUpdate}
      apiBasePath={`/api/v1/organizations/${orgId}/clients/${clientId}/contacts/${contactId}`}
      fieldIcons={FIELD_ICONS}
      formatFieldChange={formatFieldChange}
      subscribeToEvents={subscribeToEvents}
      onCommentCreated={() =>
        eventBus.emit("contact:comment:created", { contactId })
      }
      onCommentUpdated={(commentId) =>
        eventBus.emit("contact:comment:updated", { contactId, commentId })
      }
      onCommentDeleted={(commentId) =>
        eventBus.emit("contact:comment:deleted", { contactId, commentId })
      }
    />
  );
}
