// When a new app's recaps fall due, and which apps get them.

import { addZonedDays, startOfZonedDay, UTC, zonedParts, zonedTimeToUtc } from "@/lib/time-zone";

export type RecapKind = "72h" | "30d";

export const RECAP_KINDS: RecapKind[] = ["72h", "30d"];

const HOUR_MS = 3_600_000;

export const RECAP_AGE_MS: Record<RecapKind, number> = { "72h": 72 * HOUR_MS, "30d": 30 * 24 * HOUR_MS };

/** Local hour recaps send, so every recap due on a day goes out together. */
export const RECAP_HOUR = 9;

/** The first RECAP_HOUR in `tz` at least `kind` after the deploy. */
export function recapDueAt(deployedAt: Date, kind: RecapKind, tz: string = UTC): Date {
  const target = new Date(deployedAt.getTime() + RECAP_AGE_MS[kind]);
  const at = (day: Date) => zonedTimeToUtc({ ...zonedParts(day, tz), hour: RECAP_HOUR, minute: 0 }, tz);
  const day = startOfZonedDay(target, tz);
  const same = at(day);
  return same >= target ? same : at(addZonedDays(day, 1, tz));
}

export type RecapCandidate = {
  parentAppId: string | null;
  isSystemManaged: boolean;
  orgIsSystemManaged: boolean;
  /** Type of the environment the deploy went to; null is the app's default. */
  environmentType: string | null;
  groupEnvironmentId: string | null;
};

/** Production apps only: no PR previews, compose children or Vardo's own services. */
export function recapEligible(c: RecapCandidate): boolean {
  if (c.parentAppId || c.isSystemManaged || c.orgIsSystemManaged) return false;
  if (c.groupEnvironmentId) return false;
  return (c.environmentType ?? "production") === "production";
}

/** A due recap sends unless the app was stopped or its container is gone. A crashing app still gets one. */
export function recapStillWanted(status: string, parked: boolean): boolean {
  return !parked && status !== "stopped" && status !== "missing";
}
