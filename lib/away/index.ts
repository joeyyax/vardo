import { classifyAway } from "./classify";
import { collectAway } from "./collect";
import type { AwaySummary } from "./types";

export * from "./types";
export { classifyAway, MIN_AWAY_MS, RECURRING_FAILURE_RATE } from "./classify";
export { deriveAppStateFacts } from "./app-state";
export { collectAway } from "./collect";

/** Longest window a summary will cover, however long the absence was. */
export const MAX_WINDOW_MS = 14 * 24 * 60 * 60_000;

/**
 * Window start for a membership anchor, or null when there is nothing to look
 * back on. A first visit missed nothing, so it reports nothing.
 */
export function resolveSince(lastSeenAt: Date | null, now: Date): Date | null {
  if (!lastSeenAt) return null;
  const floor = new Date(now.getTime() - MAX_WINDOW_MS);
  return lastSeenAt < floor ? floor : lastSeenAt;
}

export async function getAwaySummary(opts: {
  orgId: string;
  userId: string;
  since: Date;
  now?: Date;
}): Promise<AwaySummary> {
  return classifyAway(await collectAway(opts));
}
