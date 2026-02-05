"use client";

import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from "react";
import { Plus, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { EntryChipsInput, type Chip } from "./entry-chips-input";
import { parseEntryText, parseDuration, parseRelativeDate } from "@/lib/entry-parser";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Suggestion = {
  client: { id: string; name: string; color: string | null };
  project: { id: string; name: string; code: string | null } | null;
  task: { id: string; name: string } | null;
  score: number;
  reason: "recent" | "frequent" | "match";
};

// Helper functions moved outside component since they don't depend on component state

/** Format duration in minutes to a human-readable string */
function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours === 0) {
    return `${mins}m`;
  }
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}

/** Build suggestion label from client/project/task hierarchy */
function getSuggestionLabel(suggestion: Suggestion): string {
  const parts = [suggestion.client.name];
  if (suggestion.project) {
    parts.push(suggestion.project.code || suggestion.project.name);
  }
  if (suggestion.task) {
    parts.push(suggestion.task.name);
  }
  return parts.join(" / ");
}

/** Get human-readable reason text for suggestion */
function getReasonText(reason: Suggestion["reason"]): string {
  switch (reason) {
    case "recent":
      return "Recent";
    case "frequent":
      return "Frequent";
    case "match":
      return "Match";
    default:
      return "";
  }
}

type SmartEntryBarProps = {
  orgId: string;
  roundingIncrement?: number;
  onEntryCreated?: () => void;
};

/**
 * Smart entry bar for creating time entries with natural language input.
 * Supports client/project/task suggestions, duration parsing, and date parsing.
 */
export function SmartEntryBar({
  orgId,
  roundingIncrement = 15,
  onEntryCreated,
}: SmartEntryBarProps) {
  const [chips, setChips] = useState<Chip[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Check if we can submit
  const hasClientChip = chips.some((c) => c.type === "client");
  const hasDurationChip = chips.some((c) => c.type === "duration");
  const canSubmit = hasClientChip && hasDurationChip;

  // Fetch suggestions from API
  const fetchSuggestions = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setSuggestions([]);
        setHasSearched(false);
        return;
      }

      try {
        const response = await fetch(
          `/api/v1/organizations/${orgId}/suggestions?query=${encodeURIComponent(query)}`
        );
        if (response.ok) {
          const data = await response.json();
          setSuggestions(data.suggestions || []);
          setHighlightedIndex(0);
          setHasSearched(true);
        }
      } catch {
        // Silently fail on suggestion fetch errors
        setSuggestions([]);
        setHasSearched(true);
      }
    },
    [orgId]
  );

  // Handle input change with debounced suggestion fetching
  const handleInputChange = useCallback(
    (value: string) => {
      setInputValue(value);
      setError(null);

      // Clear existing debounce
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      // Auto-detect duration patterns
      const durationResult = parseDuration(value);
      if (durationResult) {
        const { minutes, match } = durationResult;
        const hasDuration = chips.some((c) => c.type === "duration");

        if (!hasDuration) {
          // Round duration to increment
          const roundedMinutes =
            Math.round(minutes / roundingIncrement) * roundingIncrement || roundingIncrement;

          const durationChip: Chip = {
            id: `duration-${Date.now()}`,
            type: "duration",
            label: formatDuration(roundedMinutes),
            value: roundedMinutes,
          };

          setChips((prev) => [...prev, durationChip]);

          // Remove duration text from input and clean up extra spaces
          const beforeMatch = value.slice(0, match.index);
          const afterMatch = value.slice((match.index ?? 0) + match[0].length);
          const newValue = (beforeMatch + afterMatch).replace(/\s+/g, " ").trim();
          setInputValue(newValue);
          return;
        }
      }

      // Auto-detect relative date patterns
      const dateValue = parseRelativeDate(value);
      if (dateValue) {
        const hasDate = chips.some((c) => c.type === "date");

        if (!hasDate) {
          const dateChip: Chip = {
            id: `date-${Date.now()}`,
            type: "date",
            label: format(dateValue, "EEE, MMM d"),
            value: dateValue,
          };

          setChips((prev) => [...prev, dateChip]);

          // Find and remove the date keyword from input
          const lowerValue = value.toLowerCase();
          let newValue = value;

          // Check each date keyword and remove it
          const dateKeywords = [
            "today",
            "yesterday",
            "sunday",
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
          ];
          for (const keyword of dateKeywords) {
            const regex = new RegExp(`\\b${keyword}\\b`, "i");
            if (regex.test(lowerValue)) {
              newValue = value.replace(regex, "").trim();
              break;
            }
          }

          setInputValue(newValue);
          return;
        }
      }

      // Parse input to extract query words (excluding description context)
      const parsed = parseEntryText(value);
      const queryWords = parsed.candidates
        .filter((c) => !c.isDescriptionContext)
        .map((c) => c.text)
        .join(" ");

      // Debounce suggestion fetch
      debounceRef.current = setTimeout(() => {
        fetchSuggestions(queryWords);
      }, 150);
    },
    [chips, fetchSuggestions, roundingIncrement]
  );

  // Handle suggestion selection
  const selectSuggestion = useCallback(
    (suggestion: Suggestion) => {
      const newChips: Chip[] = [];

      // Always add client chip
      const hasClient = chips.some((c) => c.type === "client");
      if (!hasClient) {
        newChips.push({
          id: `client-${suggestion.client.id}`,
          type: "client",
          label: suggestion.client.name,
          value: suggestion.client.id,
          color: suggestion.client.color,
        });
      }

      // Add project chip if present
      if (suggestion.project) {
        const hasProject = chips.some((c) => c.type === "project");
        if (!hasProject) {
          newChips.push({
            id: `project-${suggestion.project.id}`,
            type: "project",
            label: suggestion.project.code || suggestion.project.name,
            value: suggestion.project.id,
          });
        }
      }

      // Add task chip if present
      if (suggestion.task) {
        const hasTask = chips.some((c) => c.type === "task");
        if (!hasTask) {
          newChips.push({
            id: `task-${suggestion.task.id}`,
            type: "task",
            label: suggestion.task.name,
            value: suggestion.task.id,
          });
        }
      }

      setChips((prev) => [...prev, ...newChips]);

      // Clear the input of entity words but keep description context
      const parsed = parseEntryText(inputValue);
      const descriptionText = parsed.descriptionText;
      setInputValue(descriptionText);

      // Clear suggestions
      setSuggestions([]);
      setHighlightedIndex(0);
      setHasSearched(false);
    },
    [chips, inputValue]
  );

  // Submit entry
  const handleSubmit = useCallback(async () => {
    if (!canSubmit || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const clientChip = chips.find((c) => c.type === "client");
      const projectChip = chips.find((c) => c.type === "project");
      const taskChip = chips.find((c) => c.type === "task");
      const durationChip = chips.find((c) => c.type === "duration");
      const dateChip = chips.find((c) => c.type === "date");

      const entryDate = dateChip?.value
        ? new Date(dateChip.value as Date)
        : new Date();

      const payload = {
        clientId: clientChip?.value as string,
        projectId: projectChip?.value as string | undefined,
        taskId: taskChip?.value as string | undefined,
        duration: durationChip?.value as number,
        date: entryDate.toISOString(),
        description: inputValue.trim() || undefined,
      };

      const response = await fetch(`/api/v1/organizations/${orgId}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || "Failed to create entry");
      }

      // Clear state on success
      setChips([]);
      setInputValue("");
      setSuggestions([]);
      setHighlightedIndex(0);
      setHasSearched(false);

      onEntryCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create entry");
    } finally {
      setIsSubmitting(false);
    }
  }, [canSubmit, isSubmitting, chips, inputValue, orgId, onEntryCreated]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // Handle suggestion navigation
      if (suggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHighlightedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
          return;
        }

        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHighlightedIndex((prev) => Math.max(prev - 1, 0));
          return;
        }

        if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) {
          e.preventDefault();
          const selected = suggestions[highlightedIndex];
          if (selected) {
            selectSuggestion(selected);
          }
          return;
        }
      }

      // Cmd/Ctrl+Enter to submit
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (canSubmit && !isSubmitting) {
          handleSubmit();
        }
        return;
      }

      // Escape to close suggestions
      if (e.key === "Escape") {
        setSuggestions([]);
        setHighlightedIndex(0);
        setHasSearched(false);
      }
    },
    [suggestions, highlightedIndex, selectSuggestion, canSubmit, isSubmitting, handleSubmit]
  );

  // Handle focus
  const handleFocus = useCallback(() => {
    setIsFocused(true);
  }, []);

  // Handle blur - close dropdown
  const handleBlur = useCallback(() => {
    setIsFocused(false);
  }, []);

  // Prevent blur when clicking on dropdown items
  const handleDropdownMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Clean up debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // Determine what to show in dropdown
  const showSuggestions = isFocused && suggestions.length > 0;
  const showEmptyState = isFocused && hasSearched && suggestions.length === 0 && inputValue.trim().length > 0;

  return (
    <div className="relative w-full">
      {/* Input and button container */}
      <div className="flex items-start gap-2">
        <div className="relative flex-1">
          <EntryChipsInput
            chips={chips}
            onChipsChange={setChips}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            onInputKeyDown={handleKeyDown}
            onFocus={handleFocus}
            onBlur={handleBlur}
            disabled={isSubmitting}
            placeholder="What did you work on? (e.g., Acme 1.5h meeting with client)"
          />
        </div>

        <Button
          onClick={handleSubmit}
          disabled={!canSubmit || isSubmitting}
          size="icon"
          aria-label="Add entry"
        >
          {isSubmitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
        </Button>
      </div>

      {/* Error message */}
      {error && (
        <p className="mt-1 text-sm text-destructive">{error}</p>
      )}

      {/* Suggestions dropdown */}
      {showSuggestions && (
        <div
          ref={dropdownRef}
          onMouseDown={handleDropdownMouseDown}
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.client.id}-${suggestion.project?.id ?? "none"}-${suggestion.task?.id ?? "none"}`}
              type="button"
              onClick={() => selectSuggestion(suggestion)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
                index === highlightedIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent hover:text-accent-foreground"
              )}
            >
              {/* Color dot */}
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{
                  backgroundColor: suggestion.client.color || "#6366f1",
                }}
              />

              {/* Label */}
              <span className="flex-1 truncate text-left">
                {getSuggestionLabel(suggestion)}
              </span>

              {/* Reason context */}
              <span className="shrink-0 text-xs text-muted-foreground">
                {getReasonText(suggestion.reason)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Empty suggestions state */}
      {showEmptyState && (
        <div
          onMouseDown={handleDropdownMouseDown}
          className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border bg-popover p-3 shadow-md"
        >
          <p className="text-sm text-muted-foreground">
            No matching clients or projects found
          </p>
        </div>
      )}
    </div>
  );
}
