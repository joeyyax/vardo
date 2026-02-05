"use client";

import { useState, DragEvent } from "react";
import { TimeEntry } from "./types";
import { formatDayHeader, formatDuration, getTodayISO } from "./utils";
import { EntryRow } from "./entry-row";
import { RecurringEntryRow, RecurringTemplate } from "./recurring-entry-row";
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
      clientId: string;
      projectId: string | null;
      taskId: string | null;
      durationMinutes: number;
      isBillableOverride: boolean | null;
    }>
  ) => Promise<void>;
  onDeleteEntry: (entryId: string) => Promise<void>;
  onDuplicateEntry: (entry: TimeEntry) => Promise<void>;
  onMakeRecurring?: (entry: TimeEntry) => void;
  onMoveEntry: (entryId: string, newDate: string) => Promise<void>;
  highlightedEntryId?: string;
  onClearHighlight?: () => void;
  recurringTemplates?: RecurringTemplate[];
  onRecurringAdd?: (template: RecurringTemplate) => void;
  onRecurringSkip?: (template: RecurringTemplate) => void;
  onRecurringPause?: (template: RecurringTemplate) => void;
  onRecurringDelete?: (template: RecurringTemplate) => void;
}

export function DayGroup({
  date,
  entries,
  totalMinutes,
  orgId,
  onUpdateEntry,
  onDeleteEntry,
  onDuplicateEntry,
  onMakeRecurring,
  onMoveEntry,
  highlightedEntryId,
  onClearHighlight,
  recurringTemplates,
  onRecurringAdd,
  onRecurringSkip,
  onRecurringPause,
  onRecurringDelete,
}: DayGroupProps) {
  const isToday = date === getTodayISO();
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // Only set dragOver to false if we're leaving the container entirely
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);

    const entryId = e.dataTransfer.getData("text/plain");
    const sourceDate = e.dataTransfer.getData("application/x-entry-date");

    if (entryId && sourceDate !== date) {
      onMoveEntry(entryId, date);
    }
  };

  return (
    <div
      className={cn(
        "space-y-1 rounded-lg transition-colors",
        isDragOver && "bg-primary/5 ring-2 ring-primary/20 ring-inset"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
        {/* Recurring suggestions for this day */}
        {recurringTemplates?.map((template) => (
          <RecurringEntryRow
            key={`recurring-${template.id}`}
            template={template}
            date={date}
            orgId={orgId}
            onAdd={() => onRecurringAdd?.(template)}
            onSkip={() => onRecurringSkip?.(template)}
            onPause={() => onRecurringPause?.(template)}
            onDelete={() => onRecurringDelete?.(template)}
          />
        ))}
        {entries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            orgId={orgId}
            onUpdate={onUpdateEntry}
            onDelete={onDeleteEntry}
            onDuplicate={onDuplicateEntry}
            onMakeRecurring={onMakeRecurring}
            isHighlighted={highlightedEntryId === entry.id}
            onClearHighlight={onClearHighlight}
          />
        ))}
      </div>
    </div>
  );
}
