"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Bell,
  CheckCheck,
  Loader2,
  MessageSquare,
  Pencil,
  UserPlus,
  ArrowRight,
  Link as LinkIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type NotificationType =
  | "assigned"
  | "mentioned"
  | "comment"
  | "status_changed"
  | "blocker_resolved"
  | "client_comment"
  | "edit_requested";

type Actor = {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
};

type Task = {
  id: string;
  name: string;
  projectId: string;
};

type Notification = {
  id: string;
  type: NotificationType;
  content: string;
  isRead: boolean;
  createdAt: string;
  task?: Task | null;
  actor?: Actor | null;
};

const TYPE_ICONS: Record<
  NotificationType,
  React.ComponentType<{ className?: string }>
> = {
  assigned: UserPlus,
  mentioned: MessageSquare,
  comment: MessageSquare,
  status_changed: ArrowRight,
  blocker_resolved: LinkIcon,
  client_comment: MessageSquare,
  edit_requested: Pencil,
};

const TYPE_LABELS: Record<string, string> = {
  all: "All",
  assigned: "Assignments",
  comment: "Comments",
  status_changed: "Status Changes",
  blocker_resolved: "Blockers Resolved",
  client_comment: "Client Comments",
  mentioned: "Mentions",
  edit_requested: "Edit Requests",
};

const LIMIT = 20;

export function NotificationsContent() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);

  const fetchNotifications = useCallback(
    async (reset = false) => {
      setIsLoading(true);
      try {
        const currentOffset = reset ? 0 : offset;
        const params = new URLSearchParams({
          limit: String(LIMIT),
          offset: String(currentOffset),
        });
        if (typeFilter !== "all") {
          params.set("type", typeFilter);
        }
        const res = await fetch(`/api/v1/notifications?${params}`);
        if (res.ok) {
          const data = await res.json();
          if (reset) {
            setNotifications(data.notifications);
            setOffset(LIMIT);
          } else {
            setNotifications((prev) => [...prev, ...data.notifications]);
            setOffset(currentOffset + LIMIT);
          }
          setHasMore(data.pagination.hasMore);
          setUnreadCount(data.unreadCount);
        }
      } catch {
        toast.error("Failed to load notifications");
      } finally {
        setIsLoading(false);
      }
    },
    [offset, typeFilter]
  );

  // Fetch on mount and when typeFilter changes
  useEffect(() => {
    fetchNotifications(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter]);

  const markAllAsRead = async () => {
    try {
      const res = await fetch("/api/v1/notifications", { method: "PATCH" });
      if (res.ok) {
        setNotifications((prev) =>
          prev.map((n) => ({ ...n, isRead: true }))
        );
        setUnreadCount(0);
      }
    } catch {
      toast.error("Failed to mark all as read");
    }
  };

  const markAsRead = async (id: string) => {
    try {
      await fetch(`/api/v1/notifications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isRead: true }),
      });
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      // Silent fail
    }
  };

  const handleClick = (notification: Notification) => {
    if (!notification.isRead) markAsRead(notification.id);
    if (notification.task) {
      router.push(
        `/projects/${notification.task.projectId}?task=${notification.task.id}`
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Notifications
        </h1>
        <p className="text-sm text-muted-foreground">
          Stay updated on your tasks and projects.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[180px] squircle">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="squircle">
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={markAllAsRead}
            className="squircle"
          >
            <CheckCheck className="size-4 mr-1.5" />
            Mark all read
          </Button>
        )}
      </div>

      {/* Notification list */}
      {isLoading && notifications.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No notifications yet.
        </div>
      ) : (
        <div className="space-y-1">
          {notifications.map((notification) => {
            const Icon = TYPE_ICONS[notification.type] || Bell;
            const timeAgo = formatDistanceToNow(
              new Date(notification.createdAt),
              { addSuffix: true }
            );

            return (
              <button
                key={notification.id}
                onClick={() => handleClick(notification)}
                className={cn(
                  "w-full flex items-start gap-3 px-4 py-3 text-left rounded-lg hover:bg-accent transition-colors",
                  !notification.isRead && "bg-accent/50"
                )}
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Icon className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm",
                      !notification.isRead && "font-medium"
                    )}
                  >
                    {notification.content}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {timeAgo}
                  </p>
                </div>
                {!notification.isRead && (
                  <div className="mt-2 size-2 shrink-0 rounded-full bg-primary" />
                )}
              </button>
            );
          })}

          {/* Load more */}
          {hasMore && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchNotifications(false)}
                disabled={isLoading}
                className="squircle"
              >
                {isLoading ? (
                  <Loader2 className="size-4 animate-spin mr-1.5" />
                ) : null}
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
