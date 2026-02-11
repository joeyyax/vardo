import { DayGroup, TimeEntry, WeekRange } from "./types";

export { formatDuration, parseDurationMinutes as parseDuration } from "@/lib/formatting";

/**
 * Format a date string as "Wed, Jan 29"
 */
export function formatDayHeader(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00"); // Add time to avoid timezone issues
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Get the start of the week (Monday) for a given date
 */
export function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  // Adjust so Monday is 0
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the end of the week (Sunday) for a given date
 */
export function getWeekEnd(date: Date): Date {
  const start = getWeekStart(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return end;
}

/**
 * Format a date as YYYY-MM-DD
 */
export function formatDateISO(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Get the week range (from/to dates and label) for a given date
 */
export function getWeekRange(date: Date): WeekRange {
  const start = getWeekStart(date);
  const end = getWeekEnd(date);

  const startMonth = start.toLocaleDateString("en-US", { month: "short" });
  const endMonth = end.toLocaleDateString("en-US", { month: "short" });

  let label: string;
  if (startMonth === endMonth) {
    label = `${startMonth} ${start.getDate()} - ${end.getDate()}`;
  } else {
    label = `${startMonth} ${start.getDate()} - ${endMonth} ${end.getDate()}`;
  }

  return {
    from: formatDateISO(start),
    to: formatDateISO(end),
    label,
  };
}

/**
 * Group entries by date, sorted most recent first
 */
export function groupEntriesByDate(entries: TimeEntry[]): DayGroup[] {
  const groups: Map<string, TimeEntry[]> = new Map();

  for (const entry of entries) {
    const existing = groups.get(entry.date) || [];
    existing.push(entry);
    groups.set(entry.date, existing);
  }

  // Convert to array and sort by date descending
  const result: DayGroup[] = Array.from(groups.entries())
    .map(([date, dayEntries]) => ({
      date,
      entries: dayEntries,
      totalMinutes: dayEntries.reduce((sum, e) => sum + e.durationMinutes, 0),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return result;
}

/**
 * Get today's date as YYYY-MM-DD
 */
export function getTodayISO(): string {
  return formatDateISO(new Date());
}

/**
 * Calculate total minutes for a list of entries
 */
export function calculateTotalMinutes(entries: TimeEntry[]): number {
  return entries.reduce((sum, e) => sum + e.durationMinutes, 0);
}

/**
 * Calculate today's total from entries
 */
export function calculateTodayTotal(entries: TimeEntry[]): number {
  const today = getTodayISO();
  return entries
    .filter((e) => e.date === today)
    .reduce((sum, e) => sum + e.durationMinutes, 0);
}
