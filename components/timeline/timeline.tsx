"use client";

import { useState, useEffect, useCallback } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TimeEntry, WeekRange } from "./types";
import {
  getWeekRange,
  groupEntriesByDate,
  calculateTotalMinutes,
  calculateTodayTotal,
} from "./utils";
import { WeekHeader } from "./week-header";
import { DayGroup } from "./day-group";

interface TimelineProps {
  orgId: string;
}

export function Timeline({ orgId }: TimelineProps) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [weekRange, setWeekRange] = useState<WeekRange>(() =>
    getWeekRange(new Date())
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Group entries by date
  const dayGroups = groupEntriesByDate(entries);
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
        <WeekHeader
          weekRange={weekRange}
          todayTotal={todayTotal}
          weekTotal={weekTotal}
          onPreviousWeek={goToPreviousWeek}
          onNextWeek={goToNextWeek}
          onToday={goToToday}
          isCurrentWeek={isCurrentWeek}
        />

        <div className="h-px bg-border" />

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
              />
            ))}
          </div>
        )}

        {/* Loading indicator when refetching */}
        {loading && entries.length > 0 && (
          <div className="fixed bottom-4 right-4 bg-background border rounded-lg px-3 py-2 shadow-lg">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
