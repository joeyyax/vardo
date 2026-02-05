"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  SkipForward,
  Pause,
  X,
  Repeat,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type RecurringTemplate = {
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

type RecurringSuggestionsProps = {
  orgId: string;
  date: string; // YYYY-MM-DD
  onEntryCreated: () => void;
};

export function RecurringSuggestions({
  orgId,
  date,
  onEntryCreated,
}: RecurringSuggestionsProps) {
  const [suggestions, setSuggestions] = useState<RecurringTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchSuggestions = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/recurring-templates?date=${date}`
      );
      if (res.ok) {
        const data = await res.json();
        setSuggestions(data.suggestions || []);
      }
    } catch (err) {
      console.error("Error fetching suggestions:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, date]);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  const handleAdd = async (template: RecurringTemplate) => {
    setActionLoading(template.id);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: template.clientId,
          projectId: template.projectId,
          taskId: template.taskId,
          description: template.description,
          date,
          durationMinutes: template.durationMinutes,
          recurringTemplateId: template.id,
        }),
      });

      if (res.ok) {
        // Remove from suggestions and notify parent
        setSuggestions((prev) => prev.filter((s) => s.id !== template.id));
        onEntryCreated();
      }
    } catch (err) {
      console.error("Error adding entry:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSkip = async (template: RecurringTemplate) => {
    setActionLoading(template.id);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/recurring-templates/${template.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skipDate: date }),
        }
      );

      if (res.ok) {
        setSuggestions((prev) => prev.filter((s) => s.id !== template.id));
      }
    } catch (err) {
      console.error("Error skipping:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handlePause = async (template: RecurringTemplate) => {
    setActionLoading(template.id);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/recurring-templates/${template.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isPaused: true }),
        }
      );

      if (res.ok) {
        setSuggestions((prev) => prev.filter((s) => s.id !== template.id));
      }
    } catch (err) {
      console.error("Error pausing:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async (template: RecurringTemplate) => {
    setActionLoading(template.id);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/recurring-templates/${template.id}`,
        {
          method: "DELETE",
        }
      );

      if (res.ok) {
        setSuggestions((prev) => prev.filter((s) => s.id !== template.id));
      }
    } catch (err) {
      console.error("Error canceling:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const formatDuration = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours === 0) return `${mins}m`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
  };

  const getFrequencyLabel = (frequency: string) => {
    switch (frequency) {
      case "daily":
        return "Daily";
      case "weekly":
        return "Weekly";
      case "biweekly":
        return "Biweekly";
      case "monthly":
        return "Monthly";
      case "quarterly":
        return "Quarterly";
      default:
        return frequency;
    }
  };

  if (isLoading || suggestions.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm text-primary">
        <Repeat className="size-4" />
        <span className="font-medium">Recurring entries for today</span>
      </div>

      <div className="space-y-2">
        {suggestions.map((template) => (
          <div
            key={template.id}
            className="flex items-center gap-3 rounded-md bg-background p-2 border"
          >
            {/* Color indicator */}
            <div
              className="size-2 rounded-full shrink-0"
              style={{ backgroundColor: template.client.color || "#94a3b8" }}
            />

            {/* Entry details */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium truncate">
                  {template.project?.name || template.client.name}
                </span>
                {template.task && (
                  <span className="text-xs text-muted-foreground truncate">
                    / {template.task.name}
                  </span>
                )}
              </div>
              {template.description && (
                <p className="text-xs text-muted-foreground truncate">
                  {template.description}
                </p>
              )}
            </div>

            {/* Duration & Frequency */}
            <div className="text-right shrink-0">
              <div className="text-sm font-medium">
                {formatDuration(template.durationMinutes)}
              </div>
              <div className="text-xs text-muted-foreground">
                {getFrequencyLabel(template.frequency)}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 shrink-0">
              {actionLoading === template.id ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="default"
                    className="h-7 px-2 squircle"
                    onClick={() => handleAdd(template)}
                  >
                    <Plus className="size-3" />
                    Add
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 squircle"
                    onClick={() => handleSkip(template)}
                    title="Skip this time"
                  >
                    <SkipForward className="size-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 squircle"
                    onClick={() => handlePause(template)}
                    title="Pause recurring"
                  >
                    <Pause className="size-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 squircle text-destructive hover:text-destructive"
                    onClick={() => handleCancel(template)}
                    title="Delete recurring template"
                  >
                    <X className="size-3" />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
