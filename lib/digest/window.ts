// Digest cadences and the complete UTC windows they cover.

export const DIGEST_CADENCES = ["daily", "weekly"] as const;
export type DigestCadence = (typeof DIGEST_CADENCES)[number];

export type DigestSchedule = {
  enabled: boolean;
  cadence: DigestCadence;
  /** 0 = Sunday. Weekly only. */
  dayOfWeek: number;
  /** UTC hour. */
  hourOfDay: number;
};

export const DEFAULT_DIGEST: DigestSchedule = { enabled: true, cadence: "weekly", dayOfWeek: 1, hourOfDay: 8 };

export type DigestWindow = {
  cadence: DigestCadence;
  /** Stable for the whole window; each window sends once. */
  windowKey: string;
  since: Date;
  until: Date;
};

const DAY_MS = 86_400_000;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function isDigestCadence(value: unknown): value is DigestCadence {
  return typeof value === "string" && (DIGEST_CADENCES as readonly string[]).includes(value);
}

/** A stored row over the defaults. No row is the defaults. */
export function scheduleFor(
  row: { enabled: boolean; cadence: string; dayOfWeek: number; hourOfDay: number } | null | undefined,
): DigestSchedule {
  if (!row) return DEFAULT_DIGEST;
  return {
    enabled: row.enabled,
    cadence: isDigestCadence(row.cadence) ? row.cadence : DEFAULT_DIGEST.cadence,
    dayOfWeek: row.dayOfWeek,
    hourOfDay: row.hourOfDay,
  };
}

/** The window that closed at today's UTC midnight: yesterday, or the seven days before today. Never partial. */
export function digestWindow(cadence: DigestCadence, now: Date): DigestWindow {
  const until = startOfUtcDay(now);
  const since = new Date(until.getTime() - (cadence === "daily" ? 1 : 7) * DAY_MS);
  return { cadence, windowKey: `${cadence}:${since.toISOString().slice(0, 10)}`, since, until };
}

/** Due during the org's hour, and for weekly only on its day. */
export function isDigestDue(schedule: DigestSchedule, now: Date): boolean {
  if (!schedule.enabled || now.getUTCHours() !== schedule.hourOfDay) return false;
  return schedule.cadence === "daily" || now.getUTCDay() === schedule.dayOfWeek;
}

/** Equal-width buckets across a window, oldest first. */
export function bucketStarts(window: Pick<DigestWindow, "since" | "until">, bucketMs: number): number[] {
  const out: number[] = [];
  for (let t = window.since.getTime(); t < window.until.getTime(); t += bucketMs) out.push(t);
  return out;
}

/** A daily digest charts hours; a weekly one, days. */
export function bucketMsFor(cadence: DigestCadence): number {
  return cadence === "daily" ? 60 * 60_000 : DAY_MS;
}
