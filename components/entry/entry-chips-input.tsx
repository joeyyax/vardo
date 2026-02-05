"use client";

import { useRef, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export type Chip = {
  id: string;
  type: "client" | "project" | "task" | "duration" | "date";
  label: string;
  value: unknown;
  color?: string | null;
};

type EntryChipsInputProps = {
  chips: Chip[];
  onChipsChange: (chips: Chip[]) => void;
  inputValue: string;
  onInputChange: (value: string) => void;
  onInputKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
};

/**
 * Get chip background color based on type and optional custom color.
 * Client chips use the client's color, duration/date chips use neutral colors.
 */
function getChipColor(chip: Chip): string {
  if (chip.type === "client" && chip.color) {
    return chip.color;
  }

  switch (chip.type) {
    case "client":
      return "#6366f1"; // indigo-500 fallback
    case "project":
      return "#8b5cf6"; // violet-500
    case "task":
      return "#a855f7"; // purple-500
    case "duration":
      return "#64748b"; // slate-500
    case "date":
      return "#64748b"; // slate-500
    default:
      return "#64748b";
  }
}

/**
 * Entry chips input component.
 * Renders chips inline with a text input for building natural language entries.
 */
export function EntryChipsInput({
  chips,
  onChipsChange,
  inputValue,
  onInputChange,
  onInputKeyDown,
  placeholder = "What did you work on?",
  disabled = false,
  onFocus,
  onBlur,
  className,
}: EntryChipsInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleContainerClick = () => {
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Backspace on empty input removes the last chip
    if (e.key === "Backspace" && inputValue === "" && chips.length > 0) {
      e.preventDefault();
      const newChips = chips.slice(0, -1);
      onChipsChange(newChips);
      return;
    }

    // Forward to external handler
    onInputKeyDown?.(e);
  };

  const removeChip = (chipId: string) => {
    const newChips = chips.filter((chip) => chip.id !== chipId);
    onChipsChange(newChips);
    inputRef.current?.focus();
  };

  return (
    <div
      onClick={handleContainerClick}
      className={cn(
        // Base container styles matching Input component
        "squircle flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-3 py-1.5 text-base shadow-xs transition-[color,box-shadow] md:text-sm",
        // Focus-within ring styling
        "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
        // Disabled state
        disabled && "pointer-events-none cursor-not-allowed opacity-50",
        className
      )}
    >
      {/* Render chips */}
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="squircle inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm text-white"
          style={{ backgroundColor: getChipColor(chip) }}
        >
          <span className="truncate max-w-[150px]">{chip.label}</span>
          {!disabled && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeChip(chip.id);
              }}
              className="ml-0.5 rounded-sm opacity-70 hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-white/50"
              aria-label={`Remove ${chip.label}`}
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}

      {/* Text input */}
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={chips.length === 0 ? placeholder : ""}
        disabled={disabled}
        className={cn(
          "min-w-[120px] flex-1 bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
          // When there are chips, reduce the min-width
          chips.length > 0 && "min-w-[60px]"
        )}
      />
    </div>
  );
}
