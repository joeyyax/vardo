"use client";

import { useState, useEffect, useCallback } from "react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  CheckCircle2,
  MessageSquare,
  FileText,
  Upload,
  UserPlus,
  Edit3,
  Plus,
  RefreshCw,
  ArrowRight,
  Trash2,
  Archive,
  UserMinus,
  Eye,
  Link as LinkIcon,
  Mail,
  MailCheck,
  MailX,
  MousePointer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActivityAction } from "@/lib/db/schema";

type Actor = {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
};

type Activity = {
  id: string;
  action: ActivityAction;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  isClientVisible: boolean;
  createdAt: string;
  actor: Actor | null;
  project?: { id: string; name: string } | null;
  task?: { id: string; name: string } | null;
};

type ActivityTimelineProps = {
  orgId: string;
  projectId?: string;
  taskId?: string;
  limit?: number;
  showFilters?: boolean;
  className?: string;
};

const ACTION_ICONS: Partial<Record<ActivityAction, React.ComponentType<{ className?: string }>>> = {
  created: Plus,
  updated: Edit3,
  deleted: Trash2,
  archived: Archive,
  status_changed: ArrowRight,
  assigned: UserPlus,
  unassigned: UserMinus,
  estimate_changed: Edit3,
  type_changed: Edit3,
  blocker_added: LinkIcon,
  blocker_removed: LinkIcon,
  blocker_resolved: CheckCircle2,
  related_added: LinkIcon,
  related_removed: LinkIcon,
  commented: MessageSquare,
  comment_shared: Eye,
  file_attached: Upload,
  file_removed: FileText,
  visibility_changed: Eye,
  email_sent: Mail,
  email_delivered: MailCheck,
  email_bounced: MailX,
  email_opened: Eye,
  email_clicked: MousePointer,
};

const ACTION_LABELS: Partial<Record<ActivityAction, string>> = {
  created: "created",
  updated: "updated",
  deleted: "deleted",
  archived: "archived",
  status_changed: "changed status",
  assigned: "assigned",
  unassigned: "unassigned",
  estimate_changed: "changed estimate",
  type_changed: "changed type",
  blocker_added: "added a blocker",
  blocker_removed: "removed a blocker",
  blocker_resolved: "resolved a blocker",
  related_added: "linked a related task",
  related_removed: "unlinked a related task",
  commented: "commented",
  comment_shared: "shared a comment",
  file_attached: "attached a file",
  file_removed: "removed a file",
  visibility_changed: "changed visibility",
  email_sent: "sent an email",
  email_delivered: "email delivered",
  email_bounced: "email bounced",
  email_opened: "email opened",
  email_clicked: "email link clicked",
};

export function ActivityTimeline({
  orgId,
  projectId,
  taskId,
  limit = 20,
  showFilters = false,
  className,
}: ActivityTimelineProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const fetchActivities = useCallback(async (reset = false) => {
    if (reset) {
      setIsLoading(true);
      setOffset(0);
    }

    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: (reset ? 0 : offset).toString(),
      });

      if (projectId) params.append("projectId", projectId);
      if (taskId) params.append("taskId", taskId);

      const response = await fetch(
        `/api/v1/organizations/${orgId}/activities?${params}`
      );

      if (response.ok) {
        const data = await response.json();
        if (reset) {
          setActivities(data.activities);
        } else {
          setActivities((prev) => [...prev, ...data.activities]);
        }
        setHasMore(data.pagination.hasMore);
        setOffset(data.pagination.offset + data.activities.length);
      }
    } catch (err) {
      console.error("Error fetching activities:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId, taskId, limit, offset]);

  useEffect(() => {
    fetchActivities(true);
  }, [orgId, projectId, taskId]);

  const loadMore = () => {
    fetchActivities(false);
  };

  const refresh = () => {
    fetchActivities(true);
  };

  if (isLoading && activities.length === 0) {
    return (
      <div className={cn("flex items-center justify-center py-8", className)}>
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className={cn("text-center py-8 text-muted-foreground text-sm", className)}>
        No activity yet.
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      {/* Refresh button */}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={isLoading}
          className="text-xs"
        >
          <RefreshCw className={cn("size-3 mr-1", isLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Activity list */}
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-4 top-0 bottom-0 w-px bg-border" />

        <div className="space-y-3">
          {activities.map((activity) => (
            <ActivityItem key={activity.id} activity={activity} taskId={taskId} />
          ))}
        </div>
      </div>

      {/* Load more */}
      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadMore}
            disabled={isLoading}
            className="squircle"
          >
            {isLoading ? (
              <Loader2 className="size-4 animate-spin mr-1" />
            ) : null}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

function ActivityItem({
  activity,
  taskId
}: {
  activity: Activity;
  taskId?: string;
}) {
  const Icon = ACTION_ICONS[activity.action] || Edit3;
  const actorName = activity.actor?.name || activity.actor?.email.split("@")[0] || "System";
  const timeAgo = formatDistanceToNow(new Date(activity.createdAt), { addSuffix: true });

  // Build the activity description
  const description = getActivityDescription(activity, taskId);

  return (
    <div className="relative flex gap-3 pl-0">
      {/* Icon circle */}
      <div className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-background border">
        <Icon className="size-4 text-muted-foreground" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pt-1">
        <p className="text-sm">
          <span className="font-medium">{actorName}</span>{" "}
          <span className="text-muted-foreground">{description}</span>
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">{timeAgo}</p>
      </div>
    </div>
  );
}

function getActivityDescription(activity: Activity, currentTaskId?: string): string {
  const { action, metadata, task, entityType } = activity;
  const taskName = task?.name || (metadata?.taskName as string);

  // For task-level views, we don't need to repeat the task name
  const isTaskContext = currentTaskId && entityType === "task";

  switch (action) {
    case "created":
      return isTaskContext
        ? "created this task"
        : taskName
          ? `created "${taskName}"`
          : `created a ${entityType}`;

    case "status_changed": {
      const from = metadata?.fromStatus as string | null;
      const to = metadata?.toStatus as string | null;
      const statusText = from && to
        ? `from ${formatStatus(from)} to ${formatStatus(to)}`
        : to
          ? `to ${formatStatus(to)}`
          : "the status";
      return isTaskContext
        ? `changed status ${statusText}`
        : `changed "${taskName}" ${statusText}`;
    }

    case "assigned": {
      const assigneeName = metadata?.assigneeName as string | null;
      return isTaskContext
        ? `assigned to ${assigneeName || "someone"}`
        : `assigned "${taskName}" to ${assigneeName || "someone"}`;
    }

    case "unassigned":
      return isTaskContext
        ? "unassigned this task"
        : `unassigned "${taskName}"`;

    case "commented":
      return isTaskContext
        ? "added a comment"
        : `commented on "${taskName}"`;

    case "comment_shared":
      return "shared a comment with client";

    case "file_attached": {
      const fileName = metadata?.fileName as string;
      return fileName
        ? `attached "${fileName}"`
        : "attached a file";
    }

    case "file_removed": {
      const fileName = metadata?.fileName as string;
      return fileName
        ? `removed "${fileName}"`
        : "removed a file";
    }

    case "blocker_added":
      return isTaskContext
        ? "added a blocker"
        : `added a blocker to "${taskName}"`;

    case "blocker_removed":
      return isTaskContext
        ? "removed a blocker"
        : `removed a blocker from "${taskName}"`;

    case "blocker_resolved":
      return isTaskContext
        ? "resolved a blocker"
        : `resolved a blocker on "${taskName}"`;

    case "visibility_changed":
      return "changed visibility settings";

    case "archived":
      return isTaskContext
        ? "archived this task"
        : `archived "${taskName}"`;

    case "deleted":
      return `deleted "${taskName || "an item"}"`;

    case "email_sent": {
      const recipient = metadata?.recipientEmail as string;
      return recipient ? `sent email to ${recipient}` : "sent an email";
    }

    case "email_delivered": {
      const recipient = metadata?.recipientEmail as string;
      return recipient ? `email delivered to ${recipient}` : "email delivered";
    }

    case "email_bounced": {
      const recipient = metadata?.recipientEmail as string;
      return recipient ? `email to ${recipient} bounced` : "email bounced";
    }

    case "email_opened": {
      const recipient = metadata?.recipientEmail as string;
      return recipient ? `email opened by ${recipient}` : "email opened";
    }

    case "email_clicked": {
      const recipient = metadata?.recipientEmail as string;
      return recipient ? `email link clicked by ${recipient}` : "email link clicked";
    }

    default:
      return ACTION_LABELS[action] || "performed an action";
  }
}

function formatStatus(status: string): string {
  const labels: Record<string, string> = {
    todo: "To Do",
    in_progress: "In Progress",
    review: "Review",
    done: "Done",
  };
  return labels[status] || status;
}
