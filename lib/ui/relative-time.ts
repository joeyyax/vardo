export type DateInput = Date | string | number | null | undefined;

const UNITS: { limit: number; div: number; label: string }[] = [
  { limit: 60, div: 1, label: "s" },
  { limit: 3600, div: 60, label: "m" },
  { limit: 86_400, div: 3600, label: "h" },
  { limit: 2_592_000, div: 86_400, label: "d" },
  { limit: 31_536_000, div: 2_592_000, label: "mo" },
  { limit: Infinity, div: 31_536_000, label: "y" },
];

export function toDate(input: DateInput): Date | null {
  if (input == null) return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Compact "3m ago" / "in 3m" text. Em dash for a missing or invalid date. */
export function formatRelativeTime(input: DateInput, now: Date = new Date()): string {
  const date = toDate(input);
  if (!date) return "—";

  const diffMs = date.getTime() - now.getTime();
  const seconds = Math.round(Math.abs(diffMs) / 1000);
  if (seconds < 10) return "just now";

  const unit = UNITS.find((u) => seconds < u.limit) ?? UNITS[UNITS.length - 1];
  const value = Math.max(1, Math.floor(seconds / unit.div));

  return diffMs < 0 ? `${value}${unit.label} ago` : `in ${value}${unit.label}`;
}

/** Exact local date and time, for the hover state. Em dash for a missing or invalid date. */
export function formatAbsoluteDateTime(input: DateInput): string {
  const date = toDate(input);
  if (!date) return "—";
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
