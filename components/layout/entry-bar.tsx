"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
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

/**
 * Suggestion with flexible hierarchy.
 * Can be at client, project, or task level.
 */
type Suggestion = {
  client: {
    id: string;
    name: string;
    color: string | null;
  };
  project: {
    id: string;
    name: string;
    code: string | null;
  } | null;
  task: {
    id: string;
    name: string;
  } | null;
  score: number;
  reason: "recent" | "frequent" | "match";
};

/**
 * Description suggestion from past entries.
 */
type DescriptionSuggestion = {
  description: string;
  client: {
    id: string;
    name: string;
    color: string | null;
  };
  project: {
    id: string;
    name: string;
    code: string | null;
  } | null;
  task: {
    id: string;
    name: string;
  } | null;
  durationMinutes: number;
  usageCount: number;
};

type EntryBarProps = {
  orgId: string;
  roundingIncrement?: number;
  onEntryCreated?: () => void;
};

/**
 * Parse duration string into minutes.
 * Accepts formats: "1h", "1.5h", "1h30m", "90m", "1:30", or just "1" (hours)
 * Bare numbers are treated as hours: "1" = 60min, "0.5" = 30min, "1.25" = 75min
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

  // Format: just a number (assume hours)
  // e.g., "1" = 1h, "0.5" = 30m, "1.25" = 1h 15m
  const numberMatch = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (numberMatch) {
    return Math.round(parseFloat(numberMatch[1]) * 60);
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
 * Format a suggestion for display.
 * Shows: Client / Project / Task (as available)
 */
function formatSuggestionDisplay(suggestion: Suggestion): string {
  const parts = [suggestion.client.name];
  if (suggestion.project) {
    parts.push(suggestion.project.name);
    if (suggestion.task) {
      parts.push(suggestion.task.name);
    }
  }
  return parts.join(" / ");
}

/**
 * Get a unique key for a suggestion.
 */
function getSuggestionKey(suggestion: Suggestion): string {
  return `${suggestion.client.id}|${suggestion.project?.id || ""}|${suggestion.task?.id || ""}`;
}

/**
 * Entry bar component - the main time entry form.
 * Keyboard-first design with tab navigation and shortcuts.
 * Supports flexible hierarchy: client only, client+project, or client+project+task.
 */
export function EntryBar({
  orgId,
  roundingIncrement = 15,
  onEntryCreated,
}: EntryBarProps) {
  // Form state
  const [description, setDescription] = useState("");
  const [selectedItem, setSelectedItem] = useState<Suggestion | null>(null);
  const [durationInput, setDurationInput] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  const [date, setDate] = useState<Date>(new Date());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selector state
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);

  // Date picker state
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Description autocomplete state
  const [descriptionSuggestions, setDescriptionSuggestions] = useState<DescriptionSuggestion[]>([]);
  const [descriptionDropdownOpen, setDescriptionDropdownOpen] = useState(false);
  const [descriptionHighlightedIndex, setDescriptionHighlightedIndex] = useState(0);

  // Animation state for when fields are populated from suggestion
  const [justPopulated, setJustPopulated] = useState(false);

  // Refs for keyboard navigation
  const descriptionRef = useRef<HTMLInputElement>(null);
  const descriptionDropdownRef = useRef<HTMLDivElement>(null);
  const selectorTriggerRef = useRef<HTMLButtonElement>(null);
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
        const queryParam = searchQuery ? `?query=${encodeURIComponent(searchQuery)}` : "";
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
  }, [orgId, searchQuery]);

  // Debounced search for description suggestions
  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(async () => {
      if (!orgId || description.length < 2) {
        setDescriptionSuggestions([]);
        setDescriptionDropdownOpen(false);
        return;
      }

      try {
        const params = new URLSearchParams({ query: description });
        if (selectedItem?.client.id) {
          params.set("clientId", selectedItem.client.id);
        }
        if (selectedItem?.project?.id) {
          params.set("projectId", selectedItem.project.id);
        }

        const response = await fetch(
          `/api/v1/organizations/${orgId}/entry-suggestions?${params}`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          throw new Error("Failed to fetch description suggestions");
        }

        const data = await response.json();
        const suggestions = data.suggestions || [];
        setDescriptionSuggestions(suggestions);
        setDescriptionDropdownOpen(suggestions.length > 0);
        setDescriptionHighlightedIndex(0);
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          console.error("Error fetching description suggestions:", err);
        }
      }
    }, 200);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [orgId, description, selectedItem?.client.id, selectedItem?.project?.id]);

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

  // Handle arrow keys for duration increment/decrement
  const handleDurationKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const direction = e.key === "ArrowUp" ? 1 : -1;
        const current = durationMinutes ?? 0;

        // Round to nearest increment boundary first, then step
        const rounded = Math.round(current / roundingIncrement) * roundingIncrement;
        let newValue = rounded + direction * roundingIncrement;

        // Ensure minimum of one increment
        if (newValue < roundingIncrement) {
          newValue = roundingIncrement;
        }

        setDurationMinutes(newValue);
        setDurationInput(formatDuration(newValue));
      }
    },
    [durationMinutes, roundingIncrement]
  );

  // Handle description suggestion selection
  const selectDescriptionSuggestion = useCallback(
    (suggestion: DescriptionSuggestion) => {
      setDescription(suggestion.description);
      setSelectedItem({
        client: suggestion.client,
        project: suggestion.project,
        task: suggestion.task,
        score: 0,
        reason: "recent",
      });
      const rounded = roundUpToIncrement(suggestion.durationMinutes, roundingIncrement);
      setDurationMinutes(rounded);
      setDurationInput(formatDuration(rounded));
      setDescriptionDropdownOpen(false);
      setDescriptionSuggestions([]);

      // Trigger pulse animation on populated fields
      setJustPopulated(true);
      setTimeout(() => setJustPopulated(false), 600);

      // Keep focus on description
      descriptionRef.current?.focus();
    },
    [roundingIncrement]
  );

  // Handle keyboard navigation in description field
  const handleDescriptionKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!descriptionDropdownOpen || descriptionSuggestions.length === 0) {
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setDescriptionHighlightedIndex((prev) =>
            Math.min(prev + 1, descriptionSuggestions.length - 1)
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setDescriptionHighlightedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          const selected = descriptionSuggestions[descriptionHighlightedIndex];
          if (selected) {
            selectDescriptionSuggestion(selected);
          }
          break;
        case "Escape":
          e.preventDefault();
          setDescriptionDropdownOpen(false);
          break;
        case "Tab":
          setDescriptionDropdownOpen(false);
          break;
      }
    },
    [descriptionDropdownOpen, descriptionSuggestions, descriptionHighlightedIndex, selectDescriptionSuggestion]
  );

  // Handle keyboard shortcuts for date picker (without opening popover)
  const handleDateKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      // Don't handle if popover is open (let calendar handle navigation)
      if (datePickerOpen) return;

      const currentDate = new Date(date);

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          currentDate.setDate(currentDate.getDate() - 1);
          setDate(currentDate);
          break;
        case "ArrowRight":
          e.preventDefault();
          currentDate.setDate(currentDate.getDate() + 1);
          setDate(currentDate);
          break;
        case "ArrowUp":
          e.preventDefault();
          currentDate.setDate(currentDate.getDate() - 7);
          setDate(currentDate);
          break;
        case "ArrowDown":
          e.preventDefault();
          currentDate.setDate(currentDate.getDate() + 7);
          setDate(currentDate);
          break;
        case "t":
        case "T":
          e.preventDefault();
          setDate(new Date());
          break;
      }
    },
    [date, datePickerOpen]
  );

  // Clear form
  const clearForm = useCallback(() => {
    setDescription("");
    setSelectedItem(null);
    setDurationInput("");
    setDurationMinutes(null);
    setDate(new Date());
    setError(null);
    setSearchQuery("");
    setDescriptionSuggestions([]);
    setDescriptionDropdownOpen(false);
    descriptionRef.current?.focus();
  }, []);

  // Submit form
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setError(null);

      // Validation
      if (!selectedItem) {
        setError("Please select a client, project, or task");
        selectorTriggerRef.current?.focus();
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
            clientId: selectedItem.client.id,
            projectId: selectedItem.project?.id || null,
            taskId: selectedItem.task?.id || null,
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

        // Dispatch custom event for Timeline and other listeners
        window.dispatchEvent(new CustomEvent("entry-created"));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setIsSubmitting(false);
      }
    },
    [orgId, selectedItem, description, date, durationMinutes, clearForm, onEntryCreated]
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

  // Format selected item display
  const selectedItemDisplay = selectedItem
    ? formatSuggestionDisplay(selectedItem)
    : null;

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
    >
          {/* Description input with autocomplete */}
          <div className="relative flex-1 min-w-0">
            <Input
              ref={descriptionRef}
              type="text"
              placeholder="What did you work on?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={handleDescriptionKeyDown}
              onFocus={() => {
                if (descriptionSuggestions.length > 0) {
                  setDescriptionDropdownOpen(true);
                }
              }}
              onBlur={(e) => {
                // Delay closing to allow click on dropdown items
                if (!descriptionDropdownRef.current?.contains(e.relatedTarget as Node)) {
                  setTimeout(() => setDescriptionDropdownOpen(false), 150);
                }
              }}
              className="squircle w-full"
              disabled={isSubmitting}
              autoComplete="off"
            />

            {/* Description suggestions dropdown */}
            {descriptionDropdownOpen && descriptionSuggestions.length > 0 && (
              <div
                ref={descriptionDropdownRef}
                className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-auto rounded-md border bg-popover p-1 shadow-md"
              >
                {descriptionSuggestions.map((suggestion, index) => (
                  <button
                    key={`${suggestion.description}-${suggestion.client.id}-${suggestion.project?.id || ""}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectDescriptionSuggestion(suggestion);
                    }}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
                      index === descriptionHighlightedIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {/* Color dot */}
                    <span
                      className="mt-1 size-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: suggestion.client.color || "#94a3b8",
                      }}
                    />
                    <span className="flex flex-1 flex-col gap-0.5 min-w-0">
                      {/* Description */}
                      <span className="font-medium truncate">
                        {suggestion.description}
                      </span>
                      {/* Context: Client / Project + Duration */}
                      <span className="text-xs text-muted-foreground truncate">
                        {suggestion.client.name}
                        {suggestion.project && ` / ${suggestion.project.name}`}
                        {" · "}
                        {formatDuration(suggestion.durationMinutes)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Client/Project/Task selector */}
          <Popover open={selectorOpen} onOpenChange={setSelectorOpen}>
            <PopoverTrigger asChild>
              <motion.div
                animate={justPopulated ? {
                  scale: [1, 1.03, 1],
                  transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] }
                } : {}}
              >
                <Button
                  ref={selectorTriggerRef}
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={selectorOpen}
                  className={cn(
                    "squircle w-full sm:w-auto sm:min-w-[200px] sm:max-w-[300px] justify-start text-left font-normal",
                    !selectedItem && "text-muted-foreground"
                  )}
                  disabled={isSubmitting}
                >
                  {selectedItem ? (
                    <span className="flex items-center gap-2 truncate">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{
                          backgroundColor: selectedItem.client.color || "#94a3b8",
                        }}
                      />
                      <span className="truncate">{selectedItemDisplay}</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Search className="size-4 opacity-50" />
                      <span>Select client/project...</span>
                    </span>
                  )}
                </Button>
              </motion.div>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0" align="start">
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder="Search..."
                  value={searchQuery}
                  onValueChange={setSearchQuery}
                  autoFocus
                />
                <CommandList>
                  {isLoadingSuggestions ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : suggestions.length === 0 ? (
                    <CommandEmpty>
                      {searchQuery
                        ? "No matches found."
                        : "No recent entries. Create a client first."}
                    </CommandEmpty>
                  ) : (
                    <CommandGroup>
                      {suggestions.map((suggestion) => (
                        <CommandItem
                          key={getSuggestionKey(suggestion)}
                          value={getSuggestionKey(suggestion)}
                          onSelect={() => {
                            setSelectedItem(suggestion);
                            setSelectorOpen(false);
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
                              {suggestion.task?.name || suggestion.project?.name || suggestion.client.name}
                            </span>
                            <span className="text-xs text-muted-foreground truncate">
                              {suggestion.task
                                ? `${suggestion.client.name} / ${suggestion.project?.name}`
                                : suggestion.project
                                ? suggestion.client.name
                                : "Client only"}
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
          <motion.div
            className="relative flex items-center gap-1"
            animate={justPopulated ? {
              scale: [1, 1.03, 1],
              transition: { duration: 0.4, delay: 0.1, ease: [0.4, 0, 0.2, 1] }
            } : {}}
          >
            <Input
              ref={durationRef}
              type="text"
              placeholder="0:00"
              value={durationInput}
              onChange={(e) => handleDurationChange(e.target.value)}
              onBlur={handleDurationBlur}
              onKeyDown={handleDurationKeyDown}
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
          </motion.div>

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
                onKeyDown={handleDateKeyDown}
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

          {/* Add button with submit hint */}
          <div className="relative shrink-0">
            <Button
              ref={addButtonRef}
              type="submit"
              size="icon"
              className="squircle"
              disabled={isSubmitting || !selectedItem || !durationMinutes}
            >
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              <span className="sr-only">Add entry</span>
            </Button>

            {/* Submit shortcut hint */}
            <AnimatePresence>
              {selectedItem && durationMinutes && !isSubmitting && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.2 }}
                  className="absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap"
                >
                  <span className="text-[10px] text-muted-foreground/70 font-medium">
                    ⌘↵
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

        {/* Error message - shows inline on mobile, absolute below on desktop */}
      {error && (
        <p className="w-full text-sm text-destructive sm:w-auto">
          {error}
        </p>
      )}
    </form>
  );
}
