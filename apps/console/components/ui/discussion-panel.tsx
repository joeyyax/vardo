"use client";

import * as React from "react";
import { MessageSquare, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

type DiscussionPanelProps = {
  title?: string;
  count?: number;
  children: React.ReactNode;
  composer?: React.ReactNode;
  className?: string;
};

function DiscussionPanel({
  title = "Discussion",
  count,
  children,
  composer,
  className,
}: DiscussionPanelProps) {
  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      {/* Header */}
      <div className="flex items-center gap-2 pb-3 border-b border-border/50 shrink-0">
        <MessageSquare className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{title}</h3>
        {count != null && count > 0 && (
          <span className="text-xs text-muted-foreground bg-background/50 rounded-full px-2 py-0.5 tabular-nums">
            {count}
          </span>
        )}
      </div>

      {/* Scrollable thread */}
      <div className="flex-1 overflow-y-auto py-4 min-h-0">{children}</div>

      {/* Pinned composer */}
      {composer && (
        <div className="border-t border-border/50 pt-3 shrink-0">
          {composer}
        </div>
      )}
    </div>
  );
}

function DiscussionEmptyState({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted mb-3">
        <MessageSquare className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">
        {message || "No comments yet"}
      </p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        Start the conversation below
      </p>
    </div>
  );
}

function DiscussionAvatar({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground",
        className
      )}
    >
      {initials}
    </div>
  );
}

type DiscussionActivityProps = {
  icon?: React.ReactNode;
  children: React.ReactNode;
  timestamp?: string;
};

function DiscussionActivityItem({
  icon,
  children,
  timestamp,
}: DiscussionActivityProps) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/60">
        {icon || <Activity className="size-3 text-muted-foreground" />}
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {children}
        </p>
        {timestamp && (
          <span className="text-[11px] text-muted-foreground/50">
            {timestamp}
          </span>
        )}
      </div>
    </div>
  );
}

export {
  DiscussionPanel,
  DiscussionEmptyState,
  DiscussionAvatar,
  DiscussionActivityItem,
};
