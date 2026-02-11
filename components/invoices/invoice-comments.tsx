"use client";

import { useCallback } from "react";
import {
  EntityComments,
  type ActivityEntry,
} from "@/components/ui/entity-comments";
import { eventBus } from "@/lib/events";
import { Receipt, User, Archive } from "lucide-react";

const FIELD_ICONS: Record<string, React.ReactNode> = {
  name: <Receipt className="size-3 text-muted-foreground" />,
  assignee: <User className="size-3 text-muted-foreground" />,
  archived: <Archive className="size-3 text-muted-foreground" />,
};

function formatFieldChange(activity: ActivityEntry): React.ReactNode {
  const actorName =
    activity.actorName || activity.actorEmail?.split("@")[0] || "Someone";
  const field = activity.field || "this invoice";

  const oldVal = activity.oldValue || "none";
  const newVal = activity.newValue || "none";
  return (
    <>
      <span className="font-medium">{actorName}</span> changed {field} from{" "}
      &ldquo;{oldVal}&rdquo; to &ldquo;{newVal}&rdquo;
    </>
  );
}

type InvoiceCommentsProps = {
  orgId: string;
  invoiceId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function InvoiceComments({
  orgId,
  invoiceId,
  currentUserId,
  onUpdate,
}: InvoiceCommentsProps) {
  const subscribeToEvents = useCallback(
    (fetchData: () => void) => [
      eventBus.on("invoice:comment:created", (e) => {
        if (e.invoiceId === invoiceId) fetchData();
      }),
      eventBus.on("invoice:comment:updated", (e) => {
        if (e.invoiceId === invoiceId) fetchData();
      }),
      eventBus.on("invoice:comment:deleted", (e) => {
        if (e.invoiceId === invoiceId) fetchData();
      }),
    ],
    [invoiceId]
  );

  return (
    <EntityComments
      orgId={orgId}
      entityId={invoiceId}
      currentUserId={currentUserId}
      onUpdate={onUpdate}
      apiBasePath={`/api/v1/organizations/${orgId}/invoices/${invoiceId}`}
      fieldIcons={FIELD_ICONS}
      formatFieldChange={formatFieldChange}
      subscribeToEvents={subscribeToEvents}
      onCommentCreated={() =>
        eventBus.emit("invoice:comment:created", { invoiceId })
      }
      onCommentUpdated={(commentId) =>
        eventBus.emit("invoice:comment:updated", { invoiceId, commentId })
      }
      onCommentDeleted={(commentId) =>
        eventBus.emit("invoice:comment:deleted", { invoiceId, commentId })
      }
    />
  );
}
