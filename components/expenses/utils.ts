import {
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  endOfYear,
  addMonths,
  subMonths,
  addQuarters,
  subQuarters,
  addYears,
  subYears,
  addDays,
  subDays,
  differenceInCalendarDays,
  format,
  parseISO,
  isToday,
  isSameMonth,
} from "date-fns";
import type { Expense, DateRange, ExpenseDayGroupData } from "./types";

/**
 * Date range preset definitions.
 */
export const DATE_RANGE_PRESETS = [
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "this-quarter", label: "This quarter" },
  { key: "last-quarter", label: "Last quarter" },
  { key: "this-year", label: "This year" },
  { key: "last-30", label: "Last 30 days" },
  { key: "last-90", label: "Last 90 days" },
  { key: "custom", label: "Custom range" },
] as const;

export type DateRangePresetKey = (typeof DATE_RANGE_PRESETS)[number]["key"];

/**
 * Build a DateRange from a preset key.
 */
export function getDateRangeFromPreset(key: string): DateRange {
  const now = new Date();

  switch (key) {
    case "this-month": {
      const start = startOfMonth(now);
      const end = endOfMonth(now);
      return {
        from: format(start, "yyyy-MM-dd"),
        to: format(end, "yyyy-MM-dd"),
        label: format(start, "MMMM yyyy"),
        preset: key,
      };
    }
    case "last-month": {
      const prev = subMonths(now, 1);
      const start = startOfMonth(prev);
      const end = endOfMonth(prev);
      return {
        from: format(start, "yyyy-MM-dd"),
        to: format(end, "yyyy-MM-dd"),
        label: format(start, "MMMM yyyy"),
        preset: key,
      };
    }
    case "this-quarter": {
      const start = startOfQuarter(now);
      const end = endOfQuarter(now);
      return {
        from: format(start, "yyyy-MM-dd"),
        to: format(end, "yyyy-MM-dd"),
        label: `Q${Math.ceil((now.getMonth() + 1) / 3)} ${format(now, "yyyy")}`,
        preset: key,
      };
    }
    case "last-quarter": {
      const prev = subQuarters(now, 1);
      const start = startOfQuarter(prev);
      const end = endOfQuarter(prev);
      return {
        from: format(start, "yyyy-MM-dd"),
        to: format(end, "yyyy-MM-dd"),
        label: `Q${Math.ceil((prev.getMonth() + 1) / 3)} ${format(prev, "yyyy")}`,
        preset: key,
      };
    }
    case "this-year": {
      const start = startOfYear(now);
      const end = endOfYear(now);
      return {
        from: format(start, "yyyy-MM-dd"),
        to: format(end, "yyyy-MM-dd"),
        label: format(now, "yyyy"),
        preset: key,
      };
    }
    case "last-30": {
      const start = subDays(now, 30);
      return {
        from: format(start, "yyyy-MM-dd"),
        to: format(now, "yyyy-MM-dd"),
        label: "Last 30 days",
        preset: key,
      };
    }
    case "last-90": {
      const start = subDays(now, 90);
      return {
        from: format(start, "yyyy-MM-dd"),
        to: format(now, "yyyy-MM-dd"),
        label: "Last 90 days",
        preset: key,
      };
    }
    default:
      // Fallback to this month
      return getDateRangeFromPreset("this-month");
  }
}

/**
 * Build a custom DateRange from two date strings.
 */
export function getCustomDateRange(from: string, to: string): DateRange {
  const start = parseISO(from);
  const end = parseISO(to);
  const sameYear = start.getFullYear() === end.getFullYear();

  const label = sameYear
    ? `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`
    : `${format(start, "MMM d, yyyy")} – ${format(end, "MMM d, yyyy")}`;

  return { from, to, label, preset: "custom" };
}

/**
 * Shift a DateRange forward or backward by the step implied by its preset.
 * direction: 1 = forward, -1 = backward
 */
export function shiftDateRange(range: DateRange, direction: 1 | -1): DateRange {
  const from = parseISO(range.from);
  const to = parseISO(range.to);
  const shift = direction === 1 ? 1 : -1;

  switch (range.preset) {
    case "this-month":
    case "last-month":
    case "month": {
      const newStart = addMonths(startOfMonth(from), shift);
      const newEnd = endOfMonth(newStart);
      return {
        from: format(newStart, "yyyy-MM-dd"),
        to: format(newEnd, "yyyy-MM-dd"),
        label: format(newStart, "MMMM yyyy"),
        preset: "month",
      };
    }
    case "this-quarter":
    case "last-quarter":
    case "quarter": {
      const newStart = addQuarters(startOfQuarter(from), shift);
      const newEnd = endOfQuarter(newStart);
      return {
        from: format(newStart, "yyyy-MM-dd"),
        to: format(newEnd, "yyyy-MM-dd"),
        label: `Q${Math.ceil((newStart.getMonth() + 1) / 3)} ${format(newStart, "yyyy")}`,
        preset: "quarter",
      };
    }
    case "this-year":
    case "year": {
      const newStart = addYears(startOfYear(from), shift);
      const newEnd = endOfYear(newStart);
      return {
        from: format(newStart, "yyyy-MM-dd"),
        to: format(newEnd, "yyyy-MM-dd"),
        label: format(newStart, "yyyy"),
        preset: "year",
      };
    }
    case "last-30": {
      const days = 30;
      const newFrom = addDays(from, shift * days);
      const newTo = addDays(to, shift * days);
      return getCustomDateRange(
        format(newFrom, "yyyy-MM-dd"),
        format(newTo, "yyyy-MM-dd")
      );
    }
    case "last-90": {
      const days = 90;
      const newFrom = addDays(from, shift * days);
      const newTo = addDays(to, shift * days);
      return getCustomDateRange(
        format(newFrom, "yyyy-MM-dd"),
        format(newTo, "yyyy-MM-dd")
      );
    }
    case "custom": {
      const span = differenceInCalendarDays(to, from) + 1;
      const newFrom = addDays(from, shift * span);
      const newTo = addDays(to, shift * span);
      return getCustomDateRange(
        format(newFrom, "yyyy-MM-dd"),
        format(newTo, "yyyy-MM-dd")
      );
    }
    default:
      return range;
  }
}

// --- Legacy helpers kept for compatibility ---

/** @deprecated Use getDateRangeFromPreset("this-month") */
export function getMonthRange(date: Date = new Date()): DateRange {
  const start = startOfMonth(date);
  const end = endOfMonth(date);
  return {
    from: format(start, "yyyy-MM-dd"),
    to: format(end, "yyyy-MM-dd"),
    label: format(start, "MMMM yyyy"),
    preset: "this-month",
  };
}

/** @deprecated */
export function isCurrentMonth(range: DateRange): boolean {
  const rangeStart = parseISO(range.from);
  return isSameMonth(rangeStart, new Date());
}

// ---

/**
 * Group expenses by date.
 */
export function groupExpensesByDate(
  expenses: Expense[]
): ExpenseDayGroupData[] {
  const grouped = new Map<string, Expense[]>();

  for (const expense of expenses) {
    const existing = grouped.get(expense.date) || [];
    existing.push(expense);
    grouped.set(expense.date, existing);
  }

  // Convert to array and sort by date (newest first)
  return Array.from(grouped.entries())
    .map(([date, dateExpenses]) => ({
      date,
      expenses: dateExpenses,
      totalCents: dateExpenses.reduce((sum, e) => sum + e.amountCents, 0),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export { formatCurrency } from "@/lib/formatting";

/**
 * Parse a currency string to cents.
 */
export function parseCurrency(value: string): number | null {
  // Remove currency symbols, commas, spaces
  const cleaned = value.replace(/[$,\s]/g, "");
  const amount = parseFloat(cleaned);

  if (isNaN(amount)) return null;

  // Convert to cents
  return Math.round(amount * 100);
}

/**
 * Format a date for display in day group header.
 */
export function formatDayHeader(dateStr: string): string {
  const date = parseISO(dateStr);

  if (isToday(date)) {
    return `Today — ${format(date, "EEEE, MMMM d")}`;
  }

  return format(date, "EEEE, MMMM d");
}

/**
 * Get today's date in YYYY-MM-DD format.
 */
export function getTodayDate(): string {
  return format(new Date(), "yyyy-MM-dd");
}

/**
 * Default expense categories.
 */
export const DEFAULT_CATEGORIES = [
  "Software",
  "Hosting",
  "Contractor",
  "Travel",
  "Supplies",
  "Equipment",
  "Marketing",
  "Insurance",
  "Subscriptions",
  "Other",
];
