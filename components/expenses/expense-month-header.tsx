"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DateRange, ExpenseSummary } from "./types";
import { formatCurrency, isCurrentMonth } from "./utils";

type ExpenseMonthHeaderProps = {
  monthRange: DateRange;
  summary: ExpenseSummary | null;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onThisMonth: () => void;
  isCurrentMonthView: boolean;
};

export function ExpenseMonthHeader({
  monthRange,
  summary,
  onPreviousMonth,
  onNextMonth,
  onThisMonth,
  isCurrentMonthView,
}: ExpenseMonthHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      {/* Month navigation */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          onClick={onPreviousMonth}
          className="size-8 squircle"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={onNextMonth}
          className="size-8 squircle"
        >
          <ChevronRight className="size-4" />
        </Button>
        <h2 className="text-lg font-semibold ml-2">{monthRange.label}</h2>
        {!isCurrentMonthView && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onThisMonth}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            This month
          </Button>
        )}
      </div>

      {/* Summary stats */}
      {summary && summary.count > 0 && (
        <div className="flex items-center gap-6 text-sm">
          <div className="text-muted-foreground">
            <span className="font-medium text-foreground">{summary.count}</span>{" "}
            {summary.count === 1 ? "expense" : "expenses"}
          </div>

          {summary.overheadCents > 0 && (
            <div className="text-amber-600 dark:text-amber-400">
              <span className="font-medium">
                {formatCurrency(summary.overheadCents)}
              </span>{" "}
              overhead
            </div>
          )}

          {summary.billableCents > 0 && (
            <div className="text-green-600 dark:text-green-400">
              <span className="font-medium">
                {formatCurrency(summary.billableCents)}
              </span>{" "}
              billable
            </div>
          )}

          <div className="font-semibold">
            {formatCurrency(summary.totalCents)} total
          </div>
        </div>
      )}
    </div>
  );
}
