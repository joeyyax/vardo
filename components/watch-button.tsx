"use client";

import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2 } from "lucide-react";

type WatchButtonProps = {
  entityType: "task" | "project" | "expense";
  entityId: string;
  orgId: string;
  projectId?: string;
};

function getWatcherUrl(
  entityType: "task" | "project" | "expense",
  orgId: string,
  entityId: string,
  projectId?: string
): string {
  switch (entityType) {
    case "task":
      return `/api/v1/organizations/${orgId}/projects/${projectId}/tasks/${entityId}/watchers`;
    case "project":
      return `/api/v1/organizations/${orgId}/projects/${entityId}/watchers`;
    case "expense":
      return `/api/v1/organizations/${orgId}/expenses/${entityId}/watchers`;
  }
}

export function WatchButton({
  entityType,
  entityId,
  orgId,
  projectId,
}: WatchButtonProps) {
  const [isWatching, setIsWatching] = useState(false);
  const [count, setCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isToggling, setIsToggling] = useState(false);

  const url = getWatcherUrl(entityType, orgId, entityId, projectId);

  const fetchWatchStatus = useCallback(async () => {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setIsWatching(data.isWatching);
        setCount(data.count);
      }
    } catch (err) {
      console.error("Error fetching watch status:", err);
    } finally {
      setIsLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setIsLoading(true);
    fetchWatchStatus();
  }, [fetchWatchStatus]);

  const handleToggle = async () => {
    if (isToggling) return;
    setIsToggling(true);

    // Optimistic update
    const wasWatching = isWatching;
    const prevCount = count;
    setIsWatching(!wasWatching);
    setCount(wasWatching ? prevCount - 1 : prevCount + 1);

    try {
      const res = await fetch(url, {
        method: wasWatching ? "DELETE" : "POST",
      });

      if (!res.ok) {
        // Revert on failure
        setIsWatching(wasWatching);
        setCount(prevCount);
      }
    } catch {
      // Revert on error
      setIsWatching(wasWatching);
      setCount(prevCount);
    } finally {
      setIsToggling(false);
    }
  };

  const tooltipText = count === 1
    ? "1 person watching"
    : `${count} people watching`;

  if (isLoading) {
    return (
      <Button variant="ghost" size="sm" disabled className="gap-1.5">
        <Loader2 className="size-4 animate-spin" />
        <span className="text-xs">Watch</span>
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleToggle}
          disabled={isToggling}
          className="gap-1.5"
        >
          {isWatching ? (
            <EyeOff className="size-4" />
          ) : (
            <Eye className="size-4" />
          )}
          <span className="text-xs">{isWatching ? "Watching" : "Watch"}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
