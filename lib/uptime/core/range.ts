// Ranges for uptime bars and figures: how long each covers, how wide its bars are, and where a young monitor's history starts.

import { DAY_MS, HOUR_MS, MINUTE_MS } from "./summary";
import type { Bucket } from "./types";

export const UPTIME_RANGES = ["1h", "24h", "7d", "30d", "90d"] as const;
export type UptimeRange = (typeof UPTIME_RANGES)[number];

/** How far back a range reaches and how wide its bars are, so every range draws 24 to 90 readable bars. */
export const RANGE_SPECS: Record<UptimeRange, { spanMs: number; bucketMs: number }> = {
  "1h": { spanMs: HOUR_MS, bucketMs: MINUTE_MS },
  "24h": { spanMs: DAY_MS, bucketMs: HOUR_MS },
  "7d": { spanMs: 7 * DAY_MS, bucketMs: 6 * HOUR_MS },
  "30d": { spanMs: 30 * DAY_MS, bucketMs: DAY_MS },
  "90d": { spanMs: 90 * DAY_MS, bucketMs: DAY_MS },
};

export const RANGE_LABELS: Record<UptimeRange, string> = { "1h": "1 hour", "24h": "24 hours", "7d": "7 days", "30d": "30 days", "90d": "90 days" };

/** How many bars a range draws with full history. */
export const rangeSlots = (range: UptimeRange): number => RANGE_SPECS[range].spanMs / RANGE_SPECS[range].bucketMs;

export function parseRange(value: string | null | undefined): UptimeRange | undefined {
  return UPTIME_RANGES.find((r) => r === value);
}

/** The smallest range that covers a history of this length. */
export function defaultRange(historyMs: number): UptimeRange {
  return UPTIME_RANGES.find((r) => RANGE_SPECS[r].spanMs >= historyMs) ?? "90d";
}

/** Bucket starts for a range, oldest first, the last one holding `now`. Aligned to the bucket width in UTC. */
export function bucketStarts(range: UptimeRange, now: number): number[] {
  const { spanMs, bucketMs } = RANGE_SPECS[range];
  const last = Math.floor(now / bucketMs) * bucketMs;
  const count = spanMs / bucketMs;
  return Array.from({ length: count }, (_, i) => last - (count - 1 - i) * bucketMs);
}

/** One bucket per start, with those the data lacks filled as unknown. */
export function fillBuckets(buckets: Bucket[], starts: number[], bucketMs: number): Bucket[] {
  const byStart = new Map(buckets.map((b) => [b.start, b]));
  return starts.map(
    (start) => byStart.get(start) ?? { start, minutesUp: 0, minutesDown: 0, minutesUnknown: bucketMs / MINUTE_MS, uptimePct: null, medianLatencyMs: null },
  );
}

/**
 * Drops the buckets that end before the history starts, so a monitor created today doesn't draw weeks of "no data".
 * `since` is when the history starts when it starts inside the range, else null.
 */
export function trimToHistory(buckets: Bucket[], bucketMs: number, historyStart: number | null): { buckets: Bucket[]; since: number | null } {
  if (historyStart === null || buckets.length === 0 || historyStart <= buckets[0].start) return { buckets, since: null };
  return { buckets: buckets.filter((b) => b.start + bucketMs > historyStart), since: historyStart };
}

/** "Oct 16" in `timeZone`. */
export const formatDay = (ms: number, timeZone = "UTC"): string => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(ms);
/** "10:14 PM" in `timeZone`. */
export const formatTime = (ms: number, timeZone = "UTC"): string => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(ms);
/** "Oct 16, 10:14 PM" in `timeZone`: the one way uptime prints a moment. */
export const formatWhen = (ms: number, timeZone = "UTC"): string => `${formatDay(ms, timeZone)}, ${formatTime(ms, timeZone)}`;

/** "Oct 16" for a history of a day or more, "Oct 16, 10:14 PM" for a shorter one. */
export function sinceLabel(since: number, now: number, timeZone = "UTC"): string {
  return now - since < 2 * DAY_MS ? formatWhen(since, timeZone) : formatDay(since, timeZone);
}

/** What a figure covers: "30 days", or "since Oct 16" when the history is shorter than the range. */
export function coverage(spanMs: number, historyStart: number | null, now: number, spanLabel: string, timeZone = "UTC"): { label: string; since: boolean } {
  if (historyStart !== null && now - historyStart < spanMs) return { label: `since ${sinceLabel(historyStart, now, timeZone)}`, since: true };
  return { label: spanLabel, since: false };
}
