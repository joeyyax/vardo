"use client";

import { TimeEntry } from "./types";
import { formatDayHeader, formatDuration, getTodayISO } from "./utils";
import { EntryRow } from "./entry-row";
import { cn } from "@/lib/utils";

interface DayGroupProps {
  date: string;
  entries: TimeEntry[];
  totalMinutes: number;
  orgId: string;
  onUpdateEntry: (
    entryId: string,
    updates: Partial<{
      description: string | null;
      taskId: string;
      durationMinutes: number;
      isBillableOverride: boolean | null;
    }>
  ) => Promise<void>;
  onDeleteEntry: (entryId: string) => Promise<void>;
  onDuplicateEntry: (entry: TimeEntry) => Promise<void>;
}

export function DayGroup({
  date,
  entries,
  totalMinutes,
  orgId,
  onUpdateEntry,
  onDeleteEntry,
  onDuplicateEntry,
}: DayGroupProps) {
  const isToday = date === getTodayISO();

  return (
    <div className="space-y-1">
      {/* Day header */}
      <div
        className={cn(
          "flex items-center justify-between py-2 border-b",
          isToday && "border-primary/30"
        )}
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "text-sm font-medium",
              isToday && "text-primary"
            )}
          >
            {formatDayHeader(date)}
          </span>
          {isToday && (
            <span className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded-full">
              Today
            </span>
          )}
        </div>
        <span className="text-sm font-medium tabular-nums">
          {formatDuration(totalMinutes)}
        </span>
      </div>

      {/* Entries */}
      <div className="space-y-0.5 py-2">
        {entries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            orgId={orgId}
            onUpdate={onUpdateEntry}
            onDelete={onDeleteEntry}
            onDuplicate={onDuplicateEntry}
          />
        ))}
      </div>
    </div>
  );
}
