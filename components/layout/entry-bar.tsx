"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Plus, CalendarIcon, Loader2, Search } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

type TaskSuggestion = {
  task: {
    id: string;
    name: string;
  };
  project: {
    id: string;
    name: string;
    code: string | null;
  };
  client: {
    id: string;
    name: string;
    color: string | null;
  };
  score: number;
  reason: "recent" | "frequent" | "match";
};

type EntryBarProps = {
  orgId: string;
  roundingIncrement?: number;
  onEntryCreated?: () => void;
};

/**
 * Parse duration string into minutes.
 * Accepts formats: "1h", "1.5h", "1h30m", "90m", "1:30", or just "90" (minutes)
 */
function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // Format: 1:30 (hours:minutes)
  const colonMatch = trimmed.match(/^(\d+):(\d{1,2})$/);
  if (colonMatch) {
    const hours = parseInt(colonMatch[1], 10);
    const minutes = parseInt(colonMatch[2], 10);
    return hours * 60 + minutes;
  }

  // Format: 1h30m or 1h 30m
  const hoursMinutesMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?)?\s*(\d+)?\s*m?(?:in(?:ute)?s?)?$/);
  if (hoursMinutesMatch) {
    const hours = parseFloat(hoursMinutesMatch[1]);
    const minutes = hoursMinutesMatch[2] ? parseInt(hoursMinutesMatch[2], 10) : 0;
    return Math.round(hours * 60) + minutes;
  }

  // Format: 1.5h or 1h
  const hoursMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?)?$/);
  if (hoursMatch) {
    return Math.round(parseFloat(hoursMatch[1]) * 60);
  }

  // Format: 90m or 90min
  const minutesMatch = trimmed.match(/^(\d+)\s*m(?:in(?:ute)?s?)?$/);
  if (minutesMatch) {
    return parseInt(minutesMatch[1], 10);
  }

  // Format: just a number (assume minutes)
  const numberMatch = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (numberMatch) {
    return Math.round(parseFloat(numberMatch[1]));
  }

  return null;
}

/**
 * Round minutes up to the nearest increment.
 */
function roundUpToIncrement(minutes: number, increment: number): number {
  if (increment <= 0) return minutes;
  return Math.ceil(minutes / increment) * increment;
}

/**
 * Format minutes as human-readable duration.
 */
function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}

/**
 * Entry bar component - the main time entry form.
 * Keyboard-first design with tab navigation and shortcuts.
 */
export function EntryBar({
  orgId,
  roundingIncrement = 15,
  onEntryCreated,
}: EntryBarProps) {
  // Form state
  const [description, setDescription] = useState("");
  const [selectedTask, setSelectedTask] = useState<TaskSuggestion | null>(null);
  const [durationInput, setDurationInput] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  const [date, setDate] = useState<Date>(new Date());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Task selector state
  const [taskSelectorOpen, setTaskSelectorOpen] = useState(false);
  const [taskSearchQuery, setTaskSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TaskSuggestion[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);

  // Date picker state
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Refs for keyboard navigation
  const descriptionRef = useRef<HTMLInputElement>(null);
  const taskSelectorTriggerRef = useRef<HTMLButtonElement>(null);
  const durationRef = useRef<HTMLInputElement>(null);
  const datePickerTriggerRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Debounced search for suggestions
  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(async () => {
      if (!orgId) return;

      setIsLoadingSuggestions(true);
      try {
        const queryParam = taskSearchQuery ? `?query=${encodeURIComponent(taskSearchQuery)}` : "";
        const response = await fetch(
          `/api/v1/organizations/${orgId}/suggestions${queryParam}`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          throw new Error("Failed to fetch suggestions");
        }

        const data = await response.json();
        setSuggestions(data.suggestions || []);
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          console.error("Error fetching suggestions:", err);
        }
      } finally {
        setIsLoadingSuggestions(false);
      }
    }, 300);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [orgId, taskSearchQuery]);

  // Parse and round duration when input changes
  const handleDurationChange = useCallback(
    (value: string) => {
      setDurationInput(value);
      const parsed = parseDuration(value);
      if (parsed !== null && parsed > 0) {
        const rounded = roundUpToIncrement(parsed, roundingIncrement);
        setDurationMinutes(rounded);
      } else {
        setDurationMinutes(null);
      }
    },
    [roundingIncrement]
  );

  // Handle duration blur to format the display
  const handleDurationBlur = useCallback(() => {
    if (durationMinutes !== null) {
      setDurationInput(formatDuration(durationMinutes));
    }
  }, [durationMinutes]);

  // Clear form
  const clearForm = useCallback(() => {
    setDescription("");
    setSelectedTask(null);
    setDurationInput("");
    setDurationMinutes(null);
    setDate(new Date());
    setError(null);
    setTaskSearchQuery("");
    descriptionRef.current?.focus();
  }, []);

  // Submit form
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setError(null);

      // Validation
      if (!selectedTask) {
        setError("Please select a task");
        taskSelectorTriggerRef.current?.focus();
        return;
      }

      if (!durationMinutes || durationMinutes < 1) {
        setError("Please enter a valid duration");
        durationRef.current?.focus();
        return;
      }

      setIsSubmitting(true);

      try {
        const response = await fetch(`/api/v1/organizations/${orgId}/entries`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            taskId: selectedTask.task.id,
            description: description.trim() || null,
            date: format(date, "yyyy-MM-dd"),
            durationMinutes,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "Failed to create entry");
        }

        // Success - clear form and notify
        clearForm();
        onEntryCreated?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setIsSubmitting(false);
      }
    },
    [orgId, selectedTask, description, date, durationMinutes, clearForm, onEntryCreated]
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+Enter saves from anywhere in the form
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const activeElement = document.activeElement;
        if (formRef.current?.contains(activeElement as Node)) {
          e.preventDefault();
          handleSubmit();
        }
      }

      // Escape clears the form
      if (e.key === "Escape") {
        const activeElement = document.activeElement;
        if (formRef.current?.contains(activeElement as Node)) {
          e.preventDefault();
          clearForm();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSubmit, clearForm]);

  // Format selected task display
  const selectedTaskDisplay = selectedTask
    ? `${selectedTask.client.name} / ${selectedTask.project.name} / ${selectedTask.task.name}`
    : null;

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
    >
      {/* Description input */}
      <Input
        ref={descriptionRef}
        type="text"
        placeholder="What did you work on?"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="squircle flex-1 min-w-0"
        disabled={isSubmitting}
      />

      {/* Task selector */}
      <Popover open={taskSelectorOpen} onOpenChange={setTaskSelectorOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={taskSelectorTriggerRef}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={taskSelectorOpen}
            className={cn(
              "squircle w-full sm:w-auto sm:min-w-[200px] sm:max-w-[300px] justify-start text-left font-normal",
              !selectedTask && "text-muted-foreground"
            )}
            disabled={isSubmitting}
          >
            {selectedTask ? (
              <span className="flex items-center gap-2 truncate">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor: selectedTask.client.color || "#94a3b8",
                  }}
                />
                <span className="truncate">{selectedTaskDisplay}</span>
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Search className="size-4 opacity-50" />
                <span>Select task...</span>
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search tasks..."
              value={taskSearchQuery}
              onValueChange={setTaskSearchQuery}
            />
            <CommandList>
              {isLoadingSuggestions ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : suggestions.length === 0 ? (
                <CommandEmpty>
                  {taskSearchQuery
                    ? "No matching tasks found."
                    : "No recent tasks. Create a project and task first."}
                </CommandEmpty>
              ) : (
                <CommandGroup>
                  {suggestions.map((suggestion) => (
                    <CommandItem
                      key={suggestion.task.id}
                      value={suggestion.task.id}
                      onSelect={() => {
                        setSelectedTask(suggestion);
                        setTaskSelectorOpen(false);
                        // Move focus to duration after selection
                        setTimeout(() => durationRef.current?.focus(), 0);
                      }}
                      className="flex items-start gap-2 py-2"
                    >
                      <span
                        className="mt-1.5 size-2 shrink-0 rounded-full"
                        style={{
                          backgroundColor: suggestion.client.color || "#94a3b8",
                        }}
                      />
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm font-medium truncate">
                          {suggestion.task.name}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          {suggestion.client.name} / {suggestion.project.name}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Duration input */}
      <div className="relative flex items-center gap-1">
        <Input
          ref={durationRef}
          type="text"
          placeholder="0:00"
          value={durationInput}
          onChange={(e) => handleDurationChange(e.target.value)}
          onBlur={handleDurationBlur}
          className="squircle w-full sm:w-24 text-center"
          disabled={isSubmitting}
        />
        {durationMinutes !== null &&
          durationInput &&
          parseDuration(durationInput) !== durationMinutes && (
            <span className="hidden sm:inline text-xs text-muted-foreground whitespace-nowrap">
              ({formatDuration(durationMinutes)})
            </span>
          )}
      </div>

      {/* Date picker */}
      <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={datePickerTriggerRef}
            type="button"
            variant="outline"
            className={cn(
              "squircle w-full sm:w-auto justify-start text-left font-normal",
              !date && "text-muted-foreground"
            )}
            disabled={isSubmitting}
          >
            <CalendarIcon className="size-4 mr-2" />
            {date ? format(date, "MMM d") : "Pick date"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            onSelect={(newDate) => {
              if (newDate) {
                setDate(newDate);
                setDatePickerOpen(false);
                // Move focus to add button after date selection
                setTimeout(() => addButtonRef.current?.focus(), 0);
              }
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>

      {/* Add button */}
      <Button
        ref={addButtonRef}
        type="submit"
        size="icon"
        className="squircle shrink-0"
        disabled={isSubmitting || !selectedTask || !durationMinutes}
      >
        {isSubmitting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Plus className="size-4" />
        )}
        <span className="sr-only">Add entry</span>
      </Button>

      {/* Error message - shows inline on mobile, absolute below on desktop */}
      {error && (
        <p className="w-full text-sm text-destructive sm:w-auto">
          {error}
        </p>
      )}
    </form>
  );
}
