"use client";

import React, { useCallback } from "react";
import {
  EntityComments,
  CommentCount,
  type ActivityEntry,
} from "@/components/ui/entity-comments";
import { eventBus } from "@/lib/events";
import {
  DollarSign,
  Tag,
  CalendarDays,
  FolderOpen,
  ReceiptText,
  ArrowRightLeft,
} from "lucide-react";

const FIELD_ICONS: Record<string, React.ReactNode> = {
  amount: <DollarSign className="size-3 text-muted-foreground" />,
  category: <Tag className="size-3 text-muted-foreground" />,
  date: <CalendarDays className="size-3 text-muted-foreground" />,
  project: <FolderOpen className="size-3 text-muted-foreground" />,
  billable: <ReceiptText className="size-3 text-muted-foreground" />,
  status: <ArrowRightLeft className="size-3 text-muted-foreground" />,
};

function formatFieldChange(activity: ActivityEntry): React.ReactNode {
  const actorName =
    activity.actorName || activity.actorEmail?.split("@")[0] || "Someone";
  const field = activity.field || "this expense";

  if (field === "amount") {
    const oldAmt = activity.oldValue
      ? `$${(Number(activity.oldValue) / 100).toFixed(2)}`
      : null;
    const newAmt = activity.newValue
      ? `$${(Number(activity.newValue) / 100).toFixed(2)}`
      : null;
    if (oldAmt && newAmt) {
      return (
        <>
          <span className="font-medium">{actorName}</span> changed amount from{" "}
          {oldAmt} to {newAmt}
        </>
      );
    }
  }

  if (field === "billable") {
    const nowBillable = activity.newValue === "true";
    return (
      <>
        <span className="font-medium">{actorName}</span> marked as{" "}
        {nowBillable ? "billable" : "non-billable"}
      </>
    );
  }

  if (field === "status") {
    return (
      <>
        <span className="font-medium">{actorName}</span> changed status to{" "}
        <span className="font-medium">{activity.newValue}</span>
      </>
    );
  }

  // Generic field change
  const oldVal = activity.oldValue || "none";
  const newVal = activity.newValue || "none";
  return (
    <>
      <span className="font-medium">{actorName}</span> changed {field} from{" "}
      &ldquo;{oldVal}&rdquo; to &ldquo;{newVal}&rdquo;
    </>
  );
}

type ExpenseCommentsProps = {
  orgId: string;
  expenseId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

export function ExpenseComments({
  orgId,
  expenseId,
  currentUserId,
  onUpdate,
}: ExpenseCommentsProps) {
  const subscribeToEvents = useCallback(
    (fetchData: () => void) => [
      eventBus.on("expense:updated", (e) => {
        if (e.expenseId === expenseId) fetchData();
      }),
      eventBus.on("expense:comment:created", (e) => {
        if (e.expenseId === expenseId) fetchData();
      }),
      eventBus.on("expense:comment:updated", (e) => {
        if (e.expenseId === expenseId) fetchData();
      }),
      eventBus.on("expense:comment:deleted", (e) => {
        if (e.expenseId === expenseId) fetchData();
      }),
    ],
    [expenseId]
  );

  return (
    <EntityComments
      orgId={orgId}
      entityId={expenseId}
      currentUserId={currentUserId}
      onUpdate={onUpdate}
      apiBasePath={`/api/v1/organizations/${orgId}/expenses/${expenseId}`}
      fieldIcons={FIELD_ICONS}
      formatFieldChange={formatFieldChange}
      subscribeToEvents={subscribeToEvents}
      onCommentCreated={() =>
        eventBus.emit("expense:comment:created", { expenseId })
      }
      onCommentUpdated={(commentId) =>
        eventBus.emit("expense:comment:updated", { expenseId, commentId })
      }
      onCommentDeleted={(commentId) =>
        eventBus.emit("expense:comment:deleted", { expenseId, commentId })
      }
    />
  );
}

export { CommentCount as ExpenseCommentCount };
