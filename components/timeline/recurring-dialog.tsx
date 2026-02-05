"use client";

import { useState, useEffect } from "react";
import { getDay, getDate } from "date-fns";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TimeEntry } from "./types";
import { toast } from "sonner";

type RecurringDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: TimeEntry | null;
  orgId: string;
  onSuccess?: () => void;
};

type TemplateData = {
  id: string;
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  isPaused: boolean;
};

const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function RecurringDialog({
  open,
  onOpenChange,
  entry,
  orgId,
  onSuccess,
}: RecurringDialogProps) {
  const [frequency, setFrequency] = useState<string>("weekly");
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [templateData, setTemplateData] = useState<TemplateData | null>(null);

  const isEditMode = !!entry?.recurringTemplateId;

  // Fetch template data when opening in edit mode
  useEffect(() => {
    if (open && entry?.recurringTemplateId) {
      setIsFetching(true);
      fetch(`/api/v1/organizations/${orgId}/recurring-templates/${entry.recurringTemplateId}`)
        .then((res) => res.json())
        .then((data) => {
          setTemplateData(data);
          setFrequency(data.frequency);
        })
        .catch((err) => {
          console.error("Error fetching template:", err);
          toast.error("Failed to load recurring settings");
        })
        .finally(() => setIsFetching(false));
    } else if (open) {
      // Reset to defaults for create mode
      setFrequency("weekly");
      setTemplateData(null);
    }
  }, [open, entry?.recurringTemplateId, orgId]);

  if (!entry) return null;

  const entryDate = new Date(entry.date + "T12:00:00");
  const dayOfWeek = getDay(entryDate);
  const dayOfMonth = getDate(entryDate);

  const handleCreate = async () => {
    setIsLoading(true);
    try {
      const body: Record<string, unknown> = {
        clientId: entry.client.id,
        projectId: entry.project?.id || null,
        taskId: entry.task?.id || null,
        description: entry.description,
        durationMinutes: entry.durationMinutes,
        isBillableOverride: entry.isBillableOverride,
        frequency,
        startDate: entry.date,
      };

      if (frequency === "weekly" || frequency === "biweekly") {
        body.dayOfWeek = dayOfWeek;
      } else if (frequency === "monthly" || frequency === "quarterly") {
        body.dayOfMonth = dayOfMonth;
      }

      const res = await fetch(
        `/api/v1/organizations/${orgId}/recurring-templates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create recurring template");
      }

      const newTemplate = await res.json();

      // Link the original entry to the template
      await fetch(`/api/v1/organizations/${orgId}/entries/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recurringTemplateId: newTemplate.id }),
      });

      toast.success("Recurring entry created", {
        description: getFrequencyDescription(frequency, dayOfWeek, dayOfMonth),
      });

      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      console.error("Error creating recurring template:", err);
      toast.error("Failed to create recurring entry");
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!templateData) return;

    setIsLoading(true);
    try {
      const body: Record<string, unknown> = { frequency };

      if (frequency === "weekly" || frequency === "biweekly") {
        body.dayOfWeek = dayOfWeek;
      } else if (frequency === "monthly" || frequency === "quarterly") {
        body.dayOfMonth = dayOfMonth;
      }

      const res = await fetch(
        `/api/v1/organizations/${orgId}/recurring-templates/${templateData.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update recurring template");
      }

      toast.success("Recurring settings updated");
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      console.error("Error updating recurring template:", err);
      toast.error("Failed to update recurring entry");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!templateData) return;

    setIsLoading(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/recurring-templates/${templateData.id}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        throw new Error("Failed to delete recurring template");
      }

      toast.success("Recurring entry removed");
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      console.error("Error deleting recurring template:", err);
      toast.error("Failed to remove recurring entry");
    } finally {
      setIsLoading(false);
    }
  };

  const handleTogglePause = async () => {
    if (!templateData) return;

    setIsLoading(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/recurring-templates/${templateData.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isPaused: !templateData.isPaused }),
        }
      );

      if (!res.ok) {
        throw new Error("Failed to update recurring template");
      }

      const updated = await res.json();
      setTemplateData(updated);
      toast.success(updated.isPaused ? "Recurring entry paused" : "Recurring entry resumed");
    } catch (err) {
      console.error("Error toggling pause:", err);
      toast.error("Failed to update recurring entry");
    } finally {
      setIsLoading(false);
    }
  };

  const getFrequencyDescription = (
    freq: string,
    dow: number,
    dom: number
  ): string => {
    switch (freq) {
      case "daily":
        return "Repeats every day";
      case "weekly":
        return `Repeats every ${DAYS_OF_WEEK[dow]}`;
      case "biweekly":
        return `Repeats every other ${DAYS_OF_WEEK[dow]}`;
      case "monthly":
        return `Repeats on the ${dom}${getOrdinalSuffix(dom)} of each month`;
      case "quarterly":
        return `Repeats on the ${dom}${getOrdinalSuffix(dom)} each quarter`;
      default:
        return "";
    }
  };

  const getOrdinalSuffix = (n: number): string => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  };

  const formatDuration = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours === 0) return `${mins}m`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? "Edit Recurring Entry" : "Make Entry Recurring"}
          </DialogTitle>
          <DialogDescription>
            {isEditMode
              ? "Modify the recurring schedule or remove it."
              : "This entry will repeat based on the frequency you choose."}
          </DialogDescription>
        </DialogHeader>

        {isFetching ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="space-y-4 py-4">
              {/* Entry preview */}
              <div className="rounded-md border p-3 space-y-1">
                <div className="flex items-center gap-2">
                  <div
                    className="size-2 rounded-full"
                    style={{ backgroundColor: entry.client.color || "#94a3b8" }}
                  />
                  <span className="font-medium text-sm">
                    {entry.project?.name || entry.client.name}
                  </span>
                  {entry.task && (
                    <span className="text-xs text-muted-foreground">
                      / {entry.task.name}
                    </span>
                  )}
                  <span className="ml-auto text-sm font-medium">
                    {formatDuration(entry.durationMinutes)}
                  </span>
                </div>
                {entry.description && (
                  <p className="text-xs text-muted-foreground truncate">
                    {entry.description}
                  </p>
                )}
              </div>

              {/* Paused indicator */}
              {isEditMode && templateData?.isPaused && (
                <div className="rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 p-2 text-sm text-amber-700 dark:text-amber-300">
                  This recurring entry is paused.
                </div>
              )}

              {/* Frequency selector */}
              <div className="space-y-2">
                <Label htmlFor="frequency">Repeat</Label>
                <Select value={frequency} onValueChange={setFrequency}>
                  <SelectTrigger id="frequency" className="squircle">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="squircle">
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">
                      Weekly (every {DAYS_OF_WEEK[dayOfWeek]})
                    </SelectItem>
                    <SelectItem value="biweekly">
                      Biweekly (every other {DAYS_OF_WEEK[dayOfWeek]})
                    </SelectItem>
                    <SelectItem value="monthly">
                      Monthly (on the {dayOfMonth}
                      {getOrdinalSuffix(dayOfMonth)})
                    </SelectItem>
                    <SelectItem value="quarterly">
                      Quarterly (on the {dayOfMonth}
                      {getOrdinalSuffix(dayOfMonth)})
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <p className="text-xs text-muted-foreground">
                {getFrequencyDescription(frequency, dayOfWeek, dayOfMonth)}
              </p>
            </div>

            <DialogFooter className="flex-col sm:flex-row gap-2">
              {isEditMode && (
                <div className="flex gap-2 mr-auto">
                  <Button
                    variant="outline"
                    onClick={handleTogglePause}
                    disabled={isLoading}
                    className="squircle"
                  >
                    {templateData?.isPaused ? "Resume" : "Pause"}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={isLoading}
                    className="squircle"
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </Button>
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isLoading}
                  className="squircle"
                >
                  Cancel
                </Button>
                <Button
                  onClick={isEditMode ? handleUpdate : handleCreate}
                  disabled={isLoading}
                  className="squircle"
                >
                  {isLoading && <Loader2 className="size-4 animate-spin" />}
                  {isEditMode ? "Save Changes" : "Create Recurring"}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
