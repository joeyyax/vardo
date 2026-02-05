"use client";

import { useState } from "react";
import { Check, SkipForward, Pause, X, Repeat, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDuration } from "./utils";

export type RecurringTemplate = {
  id: string;
  clientId: string;
  projectId: string | null;
  taskId: string | null;
  description: string | null;
  durationMinutes: number;
  frequency: string;
  client: {
    id: string;
    name: string;
    color: string | null;
  };
  project: {
    id: string;
    name: string;
  } | null;
  task: {
    id: string;
    name: string;
  } | null;
};

interface RecurringEntryRowProps {
  template: RecurringTemplate;
  date: string;
  orgId: string;
  onAdd: () => void | Promise<void>;
  onSkip: () => void | Promise<void>;
  onPause: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

type ActionType = "add" | "skip" | "pause" | "delete" | null;

export function RecurringEntryRow({
  template,
  onAdd,
  onSkip,
  onPause,
  onDelete,
}: RecurringEntryRowProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [action, setAction] = useState<ActionType>(null);

  const handleAction = async (
    actionType: ActionType,
    handler: () => void | Promise<void>
  ) => {
    if (isLoading) return;

    setIsLoading(true);
    setAction(actionType);
    try {
      await handler();
    } finally {
      setIsLoading(false);
      setAction(null);
    }
  };

  const clientColor = template.client.color || "#6b7280";

  // Display name: project name if available, otherwise client name
  const displayName = template.project?.name || template.client.name;

  return (
    <div
      className={cn(
        "group flex items-center gap-4 py-2 px-3 -mx-3 rounded-lg transition-colors",
        "border border-dashed border-primary/30",
        "bg-primary/5 hover:bg-primary/10"
      )}
    >
      {/* Recurring icon */}
      <div className="text-primary/60">
        <Repeat className="size-4" />
      </div>

      {/* Client color dot */}
      <div
        className="size-2 rounded-full shrink-0"
        style={{ backgroundColor: clientColor }}
      />

      {/* Project/Client name and task */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-primary/80 truncate">{displayName}</span>
        {template.task && (
          <span className="text-xs text-primary/60 truncate">
            {template.task.name}
          </span>
        )}
      </div>

      {/* Description */}
      <div className="flex-1 min-w-0">
        {template.description ? (
          <span className="text-sm text-primary/60 truncate block">
            {template.description}
          </span>
        ) : (
          <span className="text-sm text-primary/40 italic">No description</span>
        )}
      </div>

      {/* Duration */}
      <div className="w-14 text-right">
        <span className="text-sm font-medium tabular-nums text-primary/80">
          {formatDuration(template.durationMinutes)}
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1">
        {/* Add button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="default"
              size="icon-xs"
              onClick={() => handleAction("add", onAdd)}
              disabled={isLoading}
            >
              {isLoading && action === "add" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add entry</TooltipContent>
        </Tooltip>

        {/* Skip button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleAction("skip", onSkip)}
              disabled={isLoading}
            >
              {isLoading && action === "skip" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <SkipForward className="size-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Skip this occurrence</TooltipContent>
        </Tooltip>

        {/* Pause button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleAction("pause", onPause)}
              disabled={isLoading}
            >
              {isLoading && action === "pause" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Pause className="size-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Pause recurring template</TooltipContent>
        </Tooltip>

        {/* Delete button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleAction("delete", onDelete)}
              disabled={isLoading}
              className="text-muted-foreground hover:text-destructive"
            >
              {isLoading && action === "delete" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <X className="size-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete recurring template</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
