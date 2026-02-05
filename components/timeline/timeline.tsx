"use client";

import { useState, useEffect, useCallback } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useViewPreference } from "@/hooks/use-view-preference";
import { PageToolbar } from "@/components/page-toolbar";
import { ViewSwitcher } from "@/components/view-switcher";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  MoreHorizontal,
  Copy,
  Trash2,
  Repeat,
  DollarSign,
} from "lucide-react";
import { TimeEntry, WeekRange } from "./types";
import {
  getWeekRange,
  groupEntriesByDate,
  calculateTotalMinutes,
  calculateTodayTotal,
  formatDuration,
  formatDayHeader,
} from "./utils";
import { WeekHeader } from "./week-header";
import { DayGroup } from "./day-group";
import { RecurringDialog } from "./recurring-dialog";
import { RecurringTemplate } from "./recurring-entry-row";
import { format, addDays, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

const TRACK_VIEWS = ["timeline", "table"] as const;

interface TimelineProps {
  orgId: string;
  initialDate?: string;
  highlightEntryId?: string;
}

export function Timeline({ orgId, initialDate, highlightEntryId }: TimelineProps) {
  const [view, setView] = useViewPreference("track", TRACK_VIEWS, "timeline");
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [weekRange, setWeekRange] = useState<WeekRange>(() =>
    getWeekRange(initialDate ? new Date(initialDate + "T12:00:00") : new Date())
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | undefined>(highlightEntryId);
  const [recurringDialogOpen, setRecurringDialogOpen] = useState(false);
  const [recurringEntry, setRecurringEntry] = useState<TimeEntry | null>(null);
  const [recurringByDate, setRecurringByDate] = useState<Record<string, RecurringTemplate[]>>({});

  // Check if we're viewing the current week
  const isCurrentWeek = (() => {
    const currentWeekRange = getWeekRange(new Date());
    return weekRange.from === currentWeekRange.from;
  })();

  // Fetch entries for the current week
  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/entries?from=${weekRange.from}&to=${weekRange.to}`
      );

      if (!res.ok) {
        throw new Error("Failed to fetch entries");
      }

      const data = await res.json();
      setEntries(data);
    } catch (err) {
      console.error("Error fetching entries:", err);
      setError("Failed to load time entries. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [orgId, weekRange]);

  // Fetch on mount and when week changes
  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  // Listen for custom event when new entry is created from entry bar
  useEffect(() => {
    const handleEntryCreated = () => {
      fetchEntries();
    };

    window.addEventListener("entry-created", handleEntryCreated);
    return () => {
      window.removeEventListener("entry-created", handleEntryCreated);
    };
  }, [fetchEntries]);

  // Navigation handlers
  const goToPreviousWeek = () => {
    const currentStart = new Date(weekRange.from + "T12:00:00");
    currentStart.setDate(currentStart.getDate() - 7);
    setWeekRange(getWeekRange(currentStart));
  };

  const goToNextWeek = () => {
    const currentStart = new Date(weekRange.from + "T12:00:00");
    currentStart.setDate(currentStart.getDate() + 7);
    setWeekRange(getWeekRange(currentStart));
  };

  const goToToday = () => {
    setWeekRange(getWeekRange(new Date()));
  };

  // Entry mutation handlers
  const updateEntry = async (
    entryId: string,
    updates: Partial<{
      description: string | null;
      clientId: string;
      projectId: string | null;
      taskId: string | null;
      durationMinutes: number;
      isBillableOverride: boolean | null;
      date: string;
    }>
  ) => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/entries/${entryId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        }
      );

      if (!res.ok) {
        throw new Error("Failed to update entry");
      }

      const updatedEntry = await res.json();

      // Update local state optimistically
      setEntries((prev) =>
        prev.map((e) => (e.id === entryId ? updatedEntry : e))
      );
    } catch (err) {
      console.error("Error updating entry:", err);
      // Refetch to ensure consistency
      fetchEntries();
    }
  };

  const deleteEntry = async (entryId: string) => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/entries/${entryId}`,
        {
          method: "DELETE",
        }
      );

      if (!res.ok) {
        throw new Error("Failed to delete entry");
      }

      // Remove from local state
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
    } catch (err) {
      console.error("Error deleting entry:", err);
      // Refetch to ensure consistency
      fetchEntries();
    }
  };

  const duplicateEntry = async (entry: TimeEntry) => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: entry.client.id,
          projectId: entry.project?.id || null,
          taskId: entry.task?.id || null,
          description: entry.description,
          date: entry.date,
          durationMinutes: entry.durationMinutes,
          isBillableOverride: entry.isBillableOverride,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to duplicate entry");
      }

      const newEntry = await res.json();

      // Add to local state
      setEntries((prev) => [newEntry, ...prev]);
    } catch (err) {
      console.error("Error duplicating entry:", err);
      // Refetch to ensure consistency
      fetchEntries();
    }
  };

  // Open recurring dialog for an entry
  const makeRecurring = (entry: TimeEntry) => {
    setRecurringEntry(entry);
    setRecurringDialogOpen(true);
  };

  // Move entry to a different date (for drag-and-drop)
  const moveEntry = async (entryId: string, newDate: string) => {
    // Find the entry to get its current date
    const entry = entries.find((e) => e.id === entryId);
    if (!entry || entry.date === newDate) return;

    // Optimistically update local state
    setEntries((prev) =>
      prev.map((e) => (e.id === entryId ? { ...e, date: newDate } : e))
    );

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/entries/${entryId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: newDate }),
        }
      );

      if (!res.ok) {
        throw new Error("Failed to move entry");
      }

      // Refetch to get the updated entry with any server-side changes
      fetchEntries();
    } catch (err) {
      console.error("Error moving entry:", err);
      // Revert on error
      fetchEntries();
    }
  };

  // Fetch recurring suggestions for all days in the week
  const fetchRecurringSuggestions = useCallback(async () => {
    try {
      // Generate all dates in the week range
      const startDate = parseISO(weekRange.from);
      const dates: string[] = [];
      for (let i = 0; i < 7; i++) {
        dates.push(format(addDays(startDate, i), "yyyy-MM-dd"));
      }

      // Fetch suggestions for each date in parallel
      const results = await Promise.all(
        dates.map(async (date) => {
          try {
            const res = await fetch(
              `/api/v1/organizations/${orgId}/recurring-templates?date=${date}`
            );
            if (res.ok) {
              const data = await res.json();
              return { date, suggestions: data.suggestions || [] };
            }
            return { date, suggestions: [] };
          } catch {
            return { date, suggestions: [] };
          }
        })
      );

      // Group by date
      const byDate: Record<string, RecurringTemplate[]> = {};
      for (const result of results) {
        if (result.suggestions.length > 0) {
          byDate[result.date] = result.suggestions;
        }
      }
      setRecurringByDate(byDate);
    } catch (err) {
      console.error("Error fetching recurring suggestions:", err);
    }
  }, [orgId, weekRange]);

  // Fetch recurring suggestions when week changes
  useEffect(() => {
    fetchRecurringSuggestions();
  }, [fetchRecurringSuggestions]);

  // Recurring entry handlers
  const handleRecurringAdd = async (template: RecurringTemplate, date: string) => {
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
        // Remove from recurringByDate for this date
        setRecurringByDate((prev) => {
          const updated = { ...prev };
          if (updated[date]) {
            updated[date] = updated[date].filter((t) => t.id !== template.id);
            if (updated[date].length === 0) {
              delete updated[date];
            }
          }
          return updated;
        });
        // Refresh entries to show the new one
        fetchEntries();
      }
    } catch (err) {
      console.error("Error adding recurring entry:", err);
    }
  };

  const handleRecurringSkip = async (template: RecurringTemplate, date: string) => {
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
        // Remove from recurringByDate for this date
        setRecurringByDate((prev) => {
          const updated = { ...prev };
          if (updated[date]) {
            updated[date] = updated[date].filter((t) => t.id !== template.id);
            if (updated[date].length === 0) {
              delete updated[date];
            }
          }
          return updated;
        });
      }
    } catch (err) {
      console.error("Error skipping recurring entry:", err);
    }
  };

  const handleRecurringPause = async (template: RecurringTemplate) => {
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
        // Remove from all dates in recurringByDate
        setRecurringByDate((prev) => {
          const updated = { ...prev };
          for (const date of Object.keys(updated)) {
            updated[date] = updated[date].filter((t) => t.id !== template.id);
            if (updated[date].length === 0) {
              delete updated[date];
            }
          }
          return updated;
        });
      }
    } catch (err) {
      console.error("Error pausing recurring template:", err);
    }
  };

  const handleRecurringDelete = async (template: RecurringTemplate) => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/recurring-templates/${template.id}`,
        {
          method: "DELETE",
        }
      );

      if (res.ok) {
        // Remove from all dates in recurringByDate
        setRecurringByDate((prev) => {
          const updated = { ...prev };
          for (const date of Object.keys(updated)) {
            updated[date] = updated[date].filter((t) => t.id !== template.id);
            if (updated[date].length === 0) {
              delete updated[date];
            }
          }
          return updated;
        });
      }
    } catch (err) {
      console.error("Error deleting recurring template:", err);
    }
  };

  // Group entries by date, including days that only have recurring templates
  const entryGroups = groupEntriesByDate(entries);
  const entryGroupDates = new Set(entryGroups.map((g) => g.date));

  // Find dates that have recurring templates but no entries
  const recurringOnlyDates = Object.keys(recurringByDate).filter(
    (date) => !entryGroupDates.has(date) && recurringByDate[date].length > 0
  );

  // Create empty day groups for dates with only recurring templates
  const recurringOnlyGroups = recurringOnlyDates.map((date) => ({
    date,
    entries: [] as TimeEntry[],
    totalMinutes: 0,
  }));

  // Merge and sort all day groups
  const dayGroups = [...entryGroups, ...recurringOnlyGroups].sort(
    (a, b) => b.date.localeCompare(a.date)
  );

  const todayTotal = calculateTodayTotal(entries);
  const weekTotal = calculateTotalMinutes(entries);

  if (loading && entries.length === 0) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-muted/50 rounded animate-pulse" />
        <div className="h-px bg-border" />
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-6 w-32 bg-muted/50 rounded animate-pulse" />
              <div className="h-12 bg-muted/30 rounded animate-pulse" />
              <div className="h-12 bg-muted/30 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          onClick={fetchEntries}
          className="mt-2 text-sm text-destructive underline hover:no-underline"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Week navigation header */}
        <PageToolbar
          actions={
            <ViewSwitcher views={TRACK_VIEWS} value={view} onValueChange={setView} />
          }
        >
          <WeekHeader
            weekRange={weekRange}
            todayTotal={todayTotal}
            weekTotal={weekTotal}
            onPreviousWeek={goToPreviousWeek}
            onNextWeek={goToNextWeek}
            onToday={goToToday}
            isCurrentWeek={isCurrentWeek}
          />
        </PageToolbar>

        <div className="h-px bg-border" />

        {/* View content */}
        {view === "table" ? (
          <TimelineTable
            entries={entries}
            onDuplicate={duplicateEntry}
            onDelete={deleteEntry}
            onMakeRecurring={makeRecurring}
          />
        ) : (
          <>
            {/* Day groups */}
            {dayGroups.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-muted-foreground">
                  No time logged yet this week.
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  Use the entry bar above to start tracking.
                </p>
              </div>
            ) : (
              <div className="space-y-8">
                {dayGroups.map((group) => (
                  <DayGroup
                    key={group.date}
                    date={group.date}
                    entries={group.entries}
                    totalMinutes={group.totalMinutes}
                    orgId={orgId}
                    onUpdateEntry={updateEntry}
                    onDeleteEntry={deleteEntry}
                    onDuplicateEntry={duplicateEntry}
                    onMakeRecurring={makeRecurring}
                    onMoveEntry={moveEntry}
                    highlightedEntryId={highlightedId}
                    onClearHighlight={() => setHighlightedId(undefined)}
                    recurringTemplates={recurringByDate[group.date] || []}
                    onRecurringAdd={(t) => handleRecurringAdd(t, group.date)}
                    onRecurringSkip={(t) => handleRecurringSkip(t, group.date)}
                    onRecurringPause={handleRecurringPause}
                    onRecurringDelete={handleRecurringDelete}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* Loading indicator when refetching */}
        {loading && entries.length > 0 && (
          <div className="fixed bottom-4 right-4 bg-background border rounded-lg px-3 py-2 shadow-lg">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}
      </div>

      {/* Recurring dialog */}
      <RecurringDialog
        open={recurringDialogOpen}
        onOpenChange={setRecurringDialogOpen}
        entry={recurringEntry}
        orgId={orgId}
      />
    </TooltipProvider>
  );
}

// --- Table view ---

type TimelineTableProps = {
  entries: TimeEntry[];
  onDuplicate: (entry: TimeEntry) => Promise<void>;
  onDelete: (entryId: string) => Promise<void>;
  onMakeRecurring: (entry: TimeEntry) => void;
};

function TimelineTable({
  entries,
  onDuplicate,
  onDelete,
  onMakeRecurring,
}: TimelineTableProps) {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Sort entries by date descending, then by createdAt descending
  const sortedEntries = [...entries].sort((a, b) => {
    const dateCmp = b.date.localeCompare(a.date);
    if (dateCmp !== 0) return dateCmp;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await onDelete(deleteTarget);
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  };

  if (sortedEntries.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-muted-foreground">
          No time logged yet this week.
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          Use the entry bar above to start tracking.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border squircle overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Task</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Billable</TableHead>
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedEntries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="text-muted-foreground">
                  {formatDayHeader(entry.date)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div
                      className="size-2 rounded-full shrink-0"
                      style={{ backgroundColor: entry.client.color || "#94a3b8" }}
                    />
                    <span>{entry.client.name}</span>
                  </div>
                </TableCell>
                <TableCell>
                  {entry.project ? (
                    <div className="flex items-center gap-1.5">
                      <span>{entry.project.name}</span>
                      {entry.project.code && (
                        <span className="text-xs text-muted-foreground font-mono bg-muted px-1 py-0.5 rounded">
                          {entry.project.code}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">--</span>
                  )}
                </TableCell>
                <TableCell>
                  {entry.task ? (
                    <span>{entry.task.name}</span>
                  ) : (
                    <span className="text-muted-foreground">--</span>
                  )}
                </TableCell>
                <TableCell className="max-w-[300px]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate">
                      {entry.description || (
                        <span className="text-muted-foreground italic">
                          No description
                        </span>
                      )}
                    </span>
                    {entry.tags.length > 0 && (
                      <div className="flex items-center gap-1 shrink-0">
                        {entry.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary/80"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatDuration(entry.durationMinutes)}
                </TableCell>
                <TableCell>
                  <div
                    className={cn(
                      "flex items-center gap-1 text-xs",
                      entry.isBillable
                        ? "text-green-600 dark:text-green-400"
                        : "text-muted-foreground/40"
                    )}
                  >
                    <DollarSign className="size-3" />
                    {entry.isBillable ? "Billable" : "Non-billable"}
                  </div>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 squircle"
                      >
                        <MoreHorizontal className="size-4" />
                        <span className="sr-only">Actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="squircle">
                      <DropdownMenuItem onClick={() => onDuplicate(entry)}>
                        <Copy className="size-4" />
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onMakeRecurring(entry)}>
                        <Repeat className="size-4" />
                        Make recurring
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setDeleteTarget(entry.id)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete entry?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this time entry. This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
