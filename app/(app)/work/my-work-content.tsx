"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Activity,
  AlertCircle,
  Calendar,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  CircleCheck,
  Clock,
  FileSignature,
  FileText,
  Inbox,
  Loader2,
  Mail,
  Receipt,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatHoursHuman } from "@/lib/formatting";
import type {
  MyWorkData,
  WorkItem,
  ActivityItem,
  WorkloadSummary,
} from "@/lib/types/my-work";

type MyWorkContentProps = {
  orgId: string;
  currentUserId: string;
};

const SECTION_CONFIG = [
  {
    key: "overdue",
    label: "Overdue",
    icon: AlertCircle,
    iconClassName: "text-red-500",
    defaultOpen: true,
  },
  {
    key: "today",
    label: "Today",
    icon: CalendarClock,
    iconClassName: "text-foreground",
    defaultOpen: true,
  },
  {
    key: "thisWeek",
    label: "This Week",
    icon: CalendarDays,
    iconClassName: "text-blue-500",
    defaultOpen: true,
  },
  {
    key: "upcoming",
    label: "Upcoming",
    icon: Clock,
    iconClassName: "text-muted-foreground",
    defaultOpen: false,
  },
  {
    key: "needsAttention",
    label: "Needs Attention",
    icon: Inbox,
    iconClassName: "text-amber-500",
    defaultOpen: true,
  },
] as const;

type SectionKey = (typeof SECTION_CONFIG)[number]["key"];

const ITEM_TYPE_ICONS: Record<string, typeof CheckSquare> = {
  task: CheckSquare,
  invoice: FileText,
  inbox_item: Mail,
  proposal: Send,
  contract: FileSignature,
  expense: Receipt,
  calendar_event: Calendar,
};

export function MyWorkContent({ orgId }: MyWorkContentProps) {
  const router = useRouter();
  const [data, setData] = useState<MyWorkData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/my-work`
      );
      if (!response.ok) throw new Error("Failed to fetch");
      const result = await response.json();
      setData(result);
    } catch (error) {
      console.error("Error fetching my work:", error);
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleItemClick = useCallback(
    (item: WorkItem) => {
      switch (item.type) {
        case "task":
          router.push(`/tasks?task=${item.id}`);
          break;
        case "invoice":
          router.push(`/invoices/${item.id}/edit`);
          break;
        case "inbox_item":
          router.push(`/inbox?item=${item.id}`);
          break;
        case "proposal":
        case "contract":
          router.push(`/documents/${item.id}`);
          break;
        case "expense":
          router.push(`/expenses?expense=${item.id}`);
          break;
        case "calendar_event":
          // No navigation for calendar events
          break;
      }
    },
    [router]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <Card className="squircle">
        <CardContent className="py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Unable to load your work.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              setIsLoading(true);
              fetchData();
            }}
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const sectionKeys: SectionKey[] = [
    "overdue",
    "today",
    "thisWeek",
    "upcoming",
    "needsAttention",
  ];
  const hasItems = sectionKeys.some((key) => data[key].length > 0);

  if (!hasItems && data.recentActivity.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-6">
      <WorkloadSummaryBlock summary={data.summary} />

      {SECTION_CONFIG.map((section) => {
        const items = data[section.key];
        if (items.length === 0) return null;
        return (
          <WorkSection
            key={section.key}
            label={section.label}
            icon={section.icon}
            iconClassName={section.iconClassName}
            items={items}
            defaultOpen={section.defaultOpen}
            onItemClick={handleItemClick}
          />
        );
      })}

      {data.recentActivity.length > 0 && (
        <RecentActivitySection activities={data.recentActivity} />
      )}
    </div>
  );
}

// -- Workload Summary --

function WorkloadSummaryBlock({ summary }: { summary: WorkloadSummary }) {
  const hasMoney =
    summary.money.unbilledMinutes > 0 ||
    summary.money.outstandingInvoiceCents > 0 ||
    summary.money.pendingExpenseCents > 0;

  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">Today:</span>{" "}
        {formatHoursHuman(summary.today.minutesTracked)} tracked
        {summary.today.tasksCompleted > 0 &&
          `, ${summary.today.tasksCompleted} task${summary.today.tasksCompleted !== 1 ? "s" : ""} completed`}
      </p>
      <p>
        <span className="font-medium text-foreground">This week:</span>{" "}
        {formatHoursHuman(summary.thisWeek.minutesTracked)} tracked,{" "}
        {summary.thisWeek.tasksCompleted} completed,{" "}
        {summary.thisWeek.tasksRemaining} remaining
      </p>
      <p>
        <span className="font-medium text-foreground">Upcoming:</span>{" "}
        {summary.upcoming.itemsDueThisWeek} item
        {summary.upcoming.itemsDueThisWeek !== 1 ? "s" : ""} due this week
        {summary.upcoming.estimatedMinutes > 0 &&
          ` (~${formatHoursHuman(summary.upcoming.estimatedMinutes)} estimated)`}
      </p>
      {hasMoney && (
        <p>
          <span className="font-medium text-foreground">Money:</span>{" "}
          {[
            summary.money.unbilledMinutes > 0 &&
              `${formatHoursHuman(summary.money.unbilledMinutes)} unbilled`,
            summary.money.outstandingInvoiceCents > 0 &&
              `${formatCurrency(summary.money.outstandingInvoiceCents)} outstanding`,
            summary.money.pendingExpenseCents > 0 &&
              `${formatCurrency(summary.money.pendingExpenseCents)} in pending expenses`,
          ]
            .filter(Boolean)
            .join(", ")}
        </p>
      )}
    </div>
  );
}

// -- Work Section (Collapsible Card) --

function WorkSection({
  label,
  icon: Icon,
  iconClassName,
  items,
  defaultOpen,
  onItemClick,
}: {
  label: string;
  icon: typeof AlertCircle;
  iconClassName: string;
  items: WorkItem[];
  defaultOpen: boolean;
  onItemClick: (item: WorkItem) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="squircle p-0">
        <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors cursor-pointer">
          <ChevronRight
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
          <Icon className={cn("size-4", iconClassName)} />
          <span className="font-medium text-sm">{label}</span>
          <Badge variant="secondary" className="ml-auto">
            {items.length}
          </Badge>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="divide-y border-t">
            {items.map((item) => (
              <WorkItemRow
                key={`${item.type}-${item.id}`}
                item={item}
                onClick={onItemClick}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

// -- Work Item Row --

function WorkItemRow({
  item,
  onClick,
}: {
  item: WorkItem;
  onClick: (item: WorkItem) => void;
}) {
  const TypeIcon = ITEM_TYPE_ICONS[item.type] ?? CheckSquare;
  const urgency = getDueDateUrgency(item.dueDate);
  const isCalendarEvent = item.type === "calendar_event";

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-2.5 transition-colors",
        isCalendarEvent
          ? "opacity-80"
          : "hover:bg-accent/50 cursor-pointer"
      )}
      onClick={() => {
        if (!isCalendarEvent) onClick(item);
      }}
    >
      <TypeIcon className="size-4 shrink-0 text-muted-foreground" />

      <div className="flex-1 min-w-0">
        <span
          className={cn(
            "text-sm font-medium",
            isCalendarEvent && "text-muted-foreground"
          )}
        >
          {item.title}
        </span>
        {item.project && (
          <span className="text-xs text-muted-foreground ml-2">
            {item.project.name && item.project.client ? (
              <>
                {item.project.name}{" "}
                <span className="opacity-50">&middot;</span>{" "}
                {item.project.client.name}
              </>
            ) : item.project.name ? (
              item.project.name
            ) : item.project.client ? (
              item.project.client.name
            ) : null}
          </span>
        )}
      </div>

      {item.type === "expense" && item.amountCents != null && (
        <span className="text-xs font-medium shrink-0">
          {formatCurrency(item.amountCents)}
        </span>
      )}

      {isCalendarEvent && item.startTime ? (
        <span className="text-xs text-muted-foreground shrink-0">
          {item.allDay
            ? "All day"
            : new Date(item.startTime).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })}
        </span>
      ) : item.dueDate ? (
        <span
          className={cn(
            "text-xs shrink-0",
            urgency === "overdue" && "text-red-500 font-medium",
            urgency === "soon" && "text-amber-500",
            urgency === "normal" && "text-muted-foreground"
          )}
        >
          {formatDueDate(item.dueDate)}
        </span>
      ) : null}

      <Badge variant="outline" className="shrink-0 text-xs">
        {item.status}
      </Badge>
    </div>
  );
}

// -- Recent Activity --

function RecentActivitySection({
  activities,
}: {
  activities: ActivityItem[];
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">Recent Activity</span>
      </div>
      <Card className="squircle p-0">
        <div className="divide-y">
          {activities.map((activity) => (
            <div
              key={activity.id}
              className="flex items-start gap-3 px-4 py-2.5 text-sm"
            >
              <CircleCheck className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <span className="text-muted-foreground">
                  {formatActivityDescription(activity)}
                </span>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {formatRelativeTime(activity.createdAt)}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// -- Empty State --

function EmptyState() {
  return (
    <Card className="squircle">
      <CardContent className="py-12 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
          <CircleCheck className="size-6 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-lg font-medium">You&apos;re all caught up</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          No tasks, invoices, or items need your attention right now.
        </p>
      </CardContent>
    </Card>
  );
}

// -- Helpers --

function getDueDateUrgency(
  dueDate: string | null
): "overdue" | "soon" | "normal" | null {
  if (!dueDate) return null;
  const now = new Date();
  const due = new Date(dueDate);
  const diffMs = due.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return "overdue";
  if (diffDays < 3) return "soon";
  return "normal";
}

function formatDueDate(dueDate: string): string {
  const now = new Date();
  const due = new Date(dueDate);
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < -1) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays === -1) return "1d overdue";
  if (diffDays === 0) return "Due today";
  if (diffDays === 1) return "Due tomorrow";
  if (diffDays <= 7) return `Due in ${diffDays}d`;

  return due.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatActivityDescription(activity: ActivityItem): string {
  const entityLabel = activity.task?.name
    ? `"${activity.task.name}"`
    : activity.entityType;
  const projectContext = activity.project?.name
    ? ` in ${activity.project.name}`
    : "";

  if (activity.action === "status_changed" && activity.newValue) {
    return `Moved ${entityLabel} to ${activity.newValue}${projectContext}`;
  }

  if (activity.field && activity.newValue) {
    return `Updated ${activity.field} on ${entityLabel}${projectContext}`;
  }

  if (activity.action === "created") {
    return `Created ${entityLabel}${projectContext}`;
  }

  if (activity.action === "commented") {
    return `Commented on ${entityLabel}${projectContext}`;
  }

  if (activity.action === "updated") {
    return `Updated ${entityLabel}${projectContext}`;
  }

  return `${activity.action} ${entityLabel}${projectContext}`;
}

function formatRelativeTime(dateString: string): string {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
