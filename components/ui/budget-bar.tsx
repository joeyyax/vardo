"use client";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatHoursHuman } from "@/lib/formatting";

type BudgetBarProps = {
  budgetType: "hours" | "fixed";
  /** Total budget (hours for hours type, cents for fixed type) */
  budgetValue: number;
  /** Used amount (hours for hours type, cents for fixed type) */
  usedValue: number;
  /** "bar" = progress bar + text, "dot" = colored circle + tooltip, "auto" = container query switches between bar and dot */
  mode?: "bar" | "dot" | "auto";
  className?: string;
};

function getBudgetStatus(pct: number) {
  if (pct >= 100) return "over" as const;
  if (pct >= 80) return "at_risk" as const;
  return "on_budget" as const;
}

const STATUS_COLORS = {
  over: "bg-red-500",
  at_risk: "bg-amber-500",
  on_budget: "bg-primary",
} as const;

const DOT_COLORS = {
  over: "bg-red-500",
  at_risk: "bg-amber-500",
  on_budget: "bg-emerald-500",
} as const;

function formatBudgetLabel(
  budgetType: "hours" | "fixed",
  usedValue: number,
  budgetValue: number
) {
  if (budgetType === "hours") {
    return `${formatHoursHuman(usedValue * 60)} / ${formatHoursHuman(budgetValue * 60)}`;
  }
  const fmt = (cents: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  return `${fmt(usedValue)} / ${fmt(budgetValue)}`;
}

function BudgetBar({
  budgetType,
  budgetValue,
  usedValue,
  mode = "bar",
  className,
}: BudgetBarProps) {
  const pct = budgetValue > 0 ? (usedValue / budgetValue) * 100 : 0;
  const status = getBudgetStatus(pct);
  const label = formatBudgetLabel(budgetType, usedValue, budgetValue);

  if (mode === "auto") {
    return (
      <div className={cn("@container", className)}>
        {/* Bar mode — visible when container >= 200px */}
        <div className="hidden @min-[200px]:block">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{label}</span>
              <span>{Math.round(pct)}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  STATUS_COLORS[status]
                )}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
          </div>
        </div>
        {/* Dot mode — visible when container < 200px */}
        <div className="block @min-[200px]:hidden">
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  DOT_COLORS[status]
                )}
              />
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">
                {label} ({Math.round(pct)}%)
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    );
  }

  if (mode === "dot") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "size-2 shrink-0 rounded-full",
              DOT_COLORS[status],
              className
            )}
          />
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">
            {label} ({Math.round(pct)}%)
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            STATUS_COLORS[status]
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

export { BudgetBar };
export { getBudgetStatus, formatBudgetLabel };
export type { BudgetBarProps };
