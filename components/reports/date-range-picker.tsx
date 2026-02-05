"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";

export type Period = "week" | "month" | "quarter" | "year" | "custom";

type DateRangePickerProps = {
  period: Period;
  customRange: DateRange | undefined;
  onPeriodChange: (period: Period) => void;
  onCustomRangeChange: (range: DateRange | undefined) => void;
};

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "quarter", label: "This Quarter" },
  { value: "year", label: "This Year" },
  { value: "custom", label: "Custom Range" },
];

function formatDateRange(range: DateRange | undefined): string {
  if (!range?.from) {
    return "Select dates";
  }

  if (!range.to) {
    return format(range.from, "MMM d, yyyy");
  }

  const fromYear = range.from.getFullYear();
  const toYear = range.to.getFullYear();

  if (fromYear === toYear) {
    return `${format(range.from, "MMM d")} - ${format(range.to, "MMM d, yyyy")}`;
  }

  return `${format(range.from, "MMM d, yyyy")} - ${format(range.to, "MMM d, yyyy")}`;
}

export function DateRangePicker({
  period,
  customRange,
  onPeriodChange,
  onCustomRangeChange,
}: DateRangePickerProps): React.ReactElement {
  const [calendarOpen, setCalendarOpen] = useState(false);

  function handlePeriodChange(value: Period): void {
    onPeriodChange(value);
    if (value === "custom") {
      setCalendarOpen(true);
    }
  }

  function handleRangeSelect(range: DateRange | undefined): void {
    onCustomRangeChange(range);
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={period} onValueChange={handlePeriodChange}>
        <SelectTrigger className="squircle w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="squircle">
          {PERIOD_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {period === "custom" && (
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="squircle min-w-[240px]">
              <CalendarIcon className="size-4" />
              {formatDateRange(customRange)}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="squircle w-auto p-0" align="start">
            <Calendar
              mode="range"
              selected={customRange}
              onSelect={handleRangeSelect}
              numberOfMonths={2}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
