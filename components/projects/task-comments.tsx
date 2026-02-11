"use client";

import {
  EntityComments,
  CommentCount as TaskCommentCount,
  type ActivityEntry,
} from "@/components/ui/entity-comments";
import {
  DollarSign,
  Tag,
  CalendarDays,
  ArrowRightLeft,
} from "lucide-react";

const FIELD_ICONS: Record<string, React.ReactNode> = {
  name: <Tag className="size-3 text-muted-foreground" />,
  status: <ArrowRightLeft className="size-3 text-muted-foreground" />,
  billable: <DollarSign className="size-3 text-muted-foreground" />,
  rate: <DollarSign className="size-3 text-muted-foreground" />,
  estimate: <CalendarDays className="size-3 text-muted-foreground" />,
};

function formatFieldChange(activity: ActivityEntry): React.ReactNode {
  const actorName =
    activity.actorName || activity.actorEmail?.split("@")[0] || "Someone";
  const field = activity.field || "this task";

  if (field === "status") {
    return (
      <>
        <span className="font-medium">{actorName}</span> changed status to{" "}
        <span className="font-medium">{activity.newValue}</span>
      </>
    );
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

  const oldVal = activity.oldValue || "none";
  const newVal = activity.newValue || "none";
  return (
    <>
      <span className="font-medium">{actorName}</span> changed {field} from{" "}
      &ldquo;{oldVal}&rdquo; to &ldquo;{newVal}&rdquo;
    </>
  );
}

type TaskCommentsProps = {
  orgId: string;
  projectId: string;
  taskId: string;
  currentUserId: string;
  onUpdate?: () => void;
};

function TaskComments({
  orgId,
  projectId,
  taskId,
  currentUserId,
  onUpdate,
}: TaskCommentsProps) {
  return (
    <EntityComments
      orgId={orgId}
      entityId={taskId}
      currentUserId={currentUserId}
      onUpdate={onUpdate}
      apiBasePath={`/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${taskId}`}
      fieldIcons={FIELD_ICONS}
      formatFieldChange={formatFieldChange}
    />
  );
}

export { TaskComments, TaskCommentCount };
