"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { getInitials } from "@/lib/utils";

type ActivityUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

type ActivityApp = {
  id: string;
  name: string;
  displayName: string;
};

type Activity = {
  id: string;
  action: string;
  metadata: unknown;
  createdAt: Date | string;
  user: ActivityUser | null;
  app: ActivityApp | null;
};

type ActivityFeedProps = {
  activities: Activity[];
  orgId: string;
};

function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return "just now";
  if (diffMinutes === 1) return "1 minute ago";
  if (diffMinutes < 60) return `${diffMinutes} minutes ago`;
  if (diffHours === 1) return "1 hour ago";
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  return then.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: then.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function getDateGroup(date: Date | string): string {
  const now = new Date();
  const then = new Date(date);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);

  if (then >= todayStart) return "Today";
  if (then >= yesterdayStart) return "Yesterday";

  return then.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: then.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function meta(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

function ActionDescription({
  activity,
}: {
  activity: Activity;
}) {
  const { action, app } = activity;
  const metadata = meta(activity.metadata);

  const appLink = app ? (
    <Link
      href={`/apps/${app.name}`}
      className="font-semibold hover:underline"
    >
      {app.displayName}
    </Link>
  ) : null;

  switch (action) {
    case "project.created":
      return (
        <span>
          created {appLink ?? <span className="font-semibold">{(metadata?.displayName as string) || (metadata?.name as string) || "an app"}</span>}
        </span>
      );

    case "project.updated": {
      const changes = metadata?.changes as string[] | undefined;
      return (
        <span>
          updated {appLink ?? "an app"}
          {changes && changes.length > 0 && (
            <span className="text-muted-foreground">
              {" "}({changes.join(", ")})
            </span>
          )}
        </span>
      );
    }

    case "project.deleted": {
      const name = (metadata?.name as string) || "an app";
      return (
        <span>
          deleted project <span className="font-semibold">{name}</span>
        </span>
      );
    }

    case "deployment.started":
      return (
        <span>
          started deploy of {appLink ?? "an app"}
        </span>
      );

    case "deployment.succeeded": {
      const durationMs = metadata?.durationMs as number | undefined;
      return (
        <span>
          deployed {appLink ?? "an app"} successfully
          {durationMs && (
            <span className="text-muted-foreground">
              {" "}in {formatDuration(durationMs)}
            </span>
          )}
        </span>
      );
    }

    case "deployment.failed":
      return (
        <span>
          deploy of {appLink ?? "an app"} failed
        </span>
      );

    default:
      return (
        <span>
          {action}
          {appLink && <> on {appLink}</>}
        </span>
      );
  }
}

export function ActivityFeed({ activities: initialActivities, orgId }: ActivityFeedProps) {
  const [activities, setActivities] = useState<Activity[]>(initialActivities);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(initialActivities.length === 50);

  const loadMore = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/activities?offset=${activities.length}&limit=50`
      );
      if (!res.ok) return;
      const data = await res.json();
      setActivities((prev) => [...prev, ...data.activities]);
      setHasMore(data.pagination.hasMore);
    } finally {
      setLoading(false);
    }
  }, [orgId, activities.length]);

  if (activities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <p className="text-sm text-muted-foreground">
          No activity recorded yet.
        </p>
      </div>
    );
  }

  // Group activities by date
  const grouped: { label: string; items: Activity[] }[] = [];
  for (const activity of activities) {
    const label = getDateGroup(activity.createdAt);
    const last = grouped[grouped.length - 1];
    if (last && last.label === label) {
      last.items.push(activity);
    } else {
      grouped.push({ label, items: [activity] });
    }
  }

  return (
    <div className="space-y-8">
      {grouped.map((group) => (
        <div key={group.label}>
          <h2 className="mb-4 text-sm font-medium text-muted-foreground">
            {group.label}
          </h2>
          <div className="space-y-1">
            {group.items.map((activity) => (
              <div
                key={activity.id}
                className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50"
              >
                <Avatar size="sm" className="mt-0.5">
                  {activity.user?.image && (
                    <AvatarImage
                      src={activity.user.image}
                      alt={activity.user.name || activity.user.email}
                    />
                  )}
                  <AvatarFallback>
                    {activity.user
                      ? getInitials(activity.user.name, activity.user.email)
                      : "?"}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-relaxed">
                    <span className="font-medium">
                      {activity.user?.name || activity.user?.email || "System"}
                    </span>{" "}
                    <ActionDescription activity={activity} />
                  </p>
                </div>
                <time
                  className="shrink-0 text-xs text-muted-foreground"
                  dateTime={new Date(activity.createdAt).toISOString()}
                  title={new Date(activity.createdAt).toLocaleString()}
                >
                  {formatRelativeTime(activity.createdAt)}
                </time>
              </div>
            ))}
          </div>
        </div>
      ))}

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadMore}
            disabled={loading}
            className="squircle"
          >
            {loading ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
