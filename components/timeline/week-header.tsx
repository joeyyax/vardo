"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WeekRange } from "./types";
import { formatDuration } from "./utils";

interface WeekHeaderProps {
  weekRange: WeekRange;
  todayTotal: number;
  weekTotal: number;
  onPreviousWeek: () => void;
  onNextWeek: () => void;
  onToday: () => void;
  isCurrentWeek: boolean;
}

export function WeekHeader({
  weekRange,
  todayTotal,
  weekTotal,
  onPreviousWeek,
  onNextWeek,
  onToday,
  isCurrentWeek,
}: WeekHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onPreviousWeek}
          className="squircle rounded-md"
        >
          <ChevronLeft className="size-4" />
          <span className="sr-only">Previous week</span>
        </Button>

        <span className="text-sm font-medium min-w-[140px] text-center">
          Week of {weekRange.label.split(" - ")[0]}
        </span>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onNextWeek}
          className="squircle rounded-md"
        >
          <ChevronRight className="size-4" />
          <span className="sr-only">Next week</span>
        </Button>

        {!isCurrentWeek && (
          <Button
            variant="outline"
            size="sm"
            onClick={onToday}
            className="squircle rounded-md ml-2"
          >
            Today
          </Button>
        )}
      </div>

      <div className="flex items-center gap-6 text-sm text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">Today:</span>{" "}
          {formatDuration(todayTotal)}
        </div>
        <div>
          <span className="font-medium text-foreground">Week:</span>{" "}
          {formatDuration(weekTotal)}
        </div>
      </div>
    </div>
  );
}
