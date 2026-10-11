// Ranges for the Security page and app Security tab. Client-safe.

export const GUARD_RANGES = ["1h", "24h", "7d", "30d", "90d", "all"] as const;
export type GuardRange = (typeof GUARD_RANGES)[number];
export const DEFAULT_GUARD_RANGE: GuardRange = "7d";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Mirrors RETENTION_MS: what "All time" can reach. */
export const RETAINED_MS = 90 * DAY;

export const RANGE_MS: Record<Exclude<GuardRange, "all">, number> = {
  "1h": HOUR,
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  "90d": 90 * DAY,
};

export function parseGuardRange(value: string | null | undefined): GuardRange {
  return (GUARD_RANGES as readonly string[]).includes(value ?? "") ? (value as GuardRange) : DEFAULT_GUARD_RANGE;
}

/** Where a range starts. All time starts at the earliest retained row, never past retention. */
export function rangeStart(range: GuardRange, now: Date, earliest: Date | null = null): Date {
  if (range !== "all") return new Date(now.getTime() - RANGE_MS[range]);
  const floor = now.getTime() - RETAINED_MS;
  return new Date(Math.max(floor, Math.min(earliest?.getTime() ?? now.getTime(), now.getTime())));
}

function shortDate(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Whether all time already reaches back to the retention limit. */
function retentionReached(now: Date, earliest: Date | null): boolean {
  return !!earliest && earliest.getTime() <= now.getTime() - RETAINED_MS + DAY;
}

/** "in the last 30 days", "since Oct 10". */
export function rangePhrase(range: GuardRange, now: Date, earliest: Date | null = null): string {
  switch (range) {
    case "1h":
      return "in the last hour";
    case "24h":
      return "in the last 24 hours";
    case "all":
      if (!earliest || retentionReached(now, earliest)) return "in the last 90 days";
      return `since ${shortDate(earliest)}`;
    default:
      return `in the last ${RANGE_MS[range] / DAY} days`;
  }
}

/** The picker's label. All time names its actual start. */
export function rangeLabel(range: GuardRange, now: Date = new Date(), earliest: Date | null = null): string {
  if (range !== "all") return range;
  if (!earliest) return "All time";
  return retentionReached(now, earliest) ? "All time (last 90 days)" : `All time (since ${shortDate(earliest)})`;
}

/** Hour buckets for short ranges, day buckets for long ones. */
export function rangeBuckets(range: GuardRange, now: Date, earliest: Date | null = null): { unit: "hour" | "day"; count: number } {
  if (range === "1h") return { unit: "hour", count: 1 };
  if (range === "24h") return { unit: "hour", count: 24 };
  const start = rangeStart(range, now, earliest);
  return { unit: "day", count: Math.max(1, Math.ceil((now.getTime() - start.getTime()) / DAY)) };
}
