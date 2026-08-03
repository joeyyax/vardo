export type DateInput = Date | string | number | null | undefined;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;
const MONTH = YEAR / 12;

/** Each unit runs until the next one reads as at least two of itself. */
const UNITS: { limit: number; div: number; label: string }[] = [
  { limit: MINUTE, div: 1, label: "s" },
  { limit: HOUR, div: MINUTE, label: "m" },
  { limit: DAY, div: HOUR, label: "h" },
  { limit: 2 * WEEK, div: DAY, label: "d" },
  { limit: 2 * MONTH, div: WEEK, label: "w" },
  { limit: YEAR, div: MONTH, label: "mo" },
  { limit: Infinity, div: YEAR, label: "y" },
];

export function toDate(input: DateInput): Date | null {
  if (input == null) return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function bucket(seconds: number): string {
  const unit = UNITS.find((u) => seconds < u.limit) ?? UNITS[UNITS.length - 1];
  return `${Math.max(1, Math.floor(seconds / unit.div))}${unit.label}`;
}

/** Compact "3m" / "6w" span, no direction. Em dash for a missing or invalid date. */
export function formatSpan(input: DateInput, now: Date = new Date()): string {
  const date = toDate(input);
  if (!date) return "—";
  return bucket(Math.round(Math.abs(date.getTime() - now.getTime()) / 1000));
}

/** Compact "3m ago" / "in 3m" text. Em dash for a missing or invalid date. */
export function formatRelativeTime(input: DateInput, now: Date = new Date()): string {
  const date = toDate(input);
  if (!date) return "—";

  const diffMs = date.getTime() - now.getTime();
  const seconds = Math.round(Math.abs(diffMs) / 1000);
  if (seconds < 10) return "just now";

  return diffMs < 0 ? `${bucket(seconds)} ago` : `in ${bucket(seconds)}`;
}

/** Exact local date and time, for the hover state. Em dash for a missing or invalid date. */
export function formatAbsoluteDateTime(input: DateInput): string {
  const date = toDate(input);
  if (!date) return "—";
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
