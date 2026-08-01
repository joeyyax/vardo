import { gt, lt } from "drizzle-orm";

import { db } from "@/lib/db";
import { containerSelfHeal } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

const log = logger.child("self-heal-store");

/** Rolling window for the restart cap and the give-up marker. */
export const RESTART_WINDOW_MS = 60 * 60_000;

type Entry = {
  appId: string;
  /** Epoch-ms restart timestamps, ascending. */
  restarts: number[];
  gaveUpAt: number | null;
};

/** containerId → persisted state. Write-through mirror of container_self_heal. */
const cache = new Map<string, Entry>();
let hydrated = false;
let lastPrunedAt = 0;

function windowStart(now: number): number {
  return now - RESTART_WINDOW_MS;
}

/**
 * Load the window's persisted state into memory. Runs once per process; later
 * reads are served from the mirror. Throws so the caller can skip the tick
 * rather than act on an empty budget.
 */
export async function hydrateSelfHealState(now: number): Promise<void> {
  if (hydrated) return;

  const rows = await db
    .select()
    .from(containerSelfHeal)
    .where(gt(containerSelfHeal.updatedAt, new Date(windowStart(now))));

  cache.clear();
  for (const row of rows) {
    cache.set(row.containerId, {
      appId: row.appId,
      restarts: (row.restarts ?? []).filter((t) => t > windowStart(now)),
      gaveUpAt: row.gaveUpAt ? row.gaveUpAt.getTime() : null,
    });
  }
  hydrated = true;

  const givenUp = [...cache.values()].filter((e) => e.gaveUpAt !== null).length;
  if (cache.size > 0) {
    log.info(
      `Restored self-heal state for ${cache.size} container(s), ${givenUp} of them already given up`,
    );
  }
}

/** Restart timestamps for a container inside the window, ascending. */
export function recentRestarts(containerId: string, now: number): number[] {
  const entry = cache.get(containerId);
  if (!entry) return [];
  return entry.restarts.filter((t) => t > windowStart(now));
}

/** Whether the cap is currently burned for this container. */
export function hasGivenUp(containerId: string, now: number): boolean {
  const at = cache.get(containerId)?.gaveUpAt;
  return at !== null && at !== undefined && at > windowStart(now);
}

function entryFor(appId: string, containerId: string): Entry {
  const existing = cache.get(containerId);
  if (existing) {
    existing.appId = appId;
    return existing;
  }
  const created: Entry = { appId, restarts: [], gaveUpAt: null };
  cache.set(containerId, created);
  return created;
}

async function persist(containerId: string, entry: Entry, now: number): Promise<void> {
  await db
    .insert(containerSelfHeal)
    .values({
      containerId,
      appId: entry.appId,
      restarts: entry.restarts,
      gaveUpAt: entry.gaveUpAt === null ? null : new Date(entry.gaveUpAt),
      updatedAt: new Date(now),
    })
    .onConflictDoUpdate({
      target: containerSelfHeal.containerId,
      set: {
        appId: entry.appId,
        restarts: entry.restarts,
        gaveUpAt: entry.gaveUpAt === null ? null : new Date(entry.gaveUpAt),
        updatedAt: new Date(now),
      },
    });
}

/**
 * Spend one restart from the container's budget. Returns the windowed history
 * including this restart. Write failures are logged, not thrown; the mirror
 * still holds the cap for this process.
 */
export async function recordRestart(
  appId: string,
  containerId: string,
  now: number,
): Promise<number[]> {
  const entry = entryFor(appId, containerId);
  entry.restarts = [...entry.restarts.filter((t) => t > windowStart(now)), now];

  try {
    await persist(containerId, entry, now);
  } catch (err) {
    log.error(`Failed to persist restart for ${containerId}:`, err);
  }
  return [...entry.restarts];
}

/** Mark the container as given up on. */
export async function recordGaveUp(
  appId: string,
  containerId: string,
  now: number,
): Promise<void> {
  const entry = entryFor(appId, containerId);
  entry.gaveUpAt = now;

  try {
    await persist(containerId, entry, now);
  } catch (err) {
    log.error(`Failed to persist give-up for ${containerId}:`, err);
  }
}

/** Clear the give-up marker after the container reads healthy. No-op, and no
 *  query, when there is nothing to clear. Leaves the restart history alone. */
export async function clearGaveUp(containerId: string, now: number): Promise<void> {
  const entry = cache.get(containerId);
  if (!entry || entry.gaveUpAt === null) return;
  entry.gaveUpAt = null;

  try {
    await persist(containerId, entry, now);
  } catch (err) {
    log.error(`Failed to clear give-up for ${containerId}:`, err);
  }
}

/** Drop rows and mirror entries that fell out of the window. Runs at most once
 *  per window, and always on the first tick to sweep what the previous process
 *  left behind. */
export async function pruneSelfHealState(now: number): Promise<void> {
  if (now - lastPrunedAt < RESTART_WINDOW_MS) return;
  lastPrunedAt = now;

  for (const [containerId, entry] of cache) {
    const live = entry.restarts.filter((t) => t > windowStart(now));
    const gaveUp = entry.gaveUpAt !== null && entry.gaveUpAt > windowStart(now);
    if (live.length === 0 && !gaveUp) cache.delete(containerId);
    else entry.restarts = live;
  }

  try {
    await db
      .delete(containerSelfHeal)
      .where(lt(containerSelfHeal.updatedAt, new Date(windowStart(now))));
  } catch (err) {
    log.error("Failed to prune self-heal state:", err);
  }
}

/** Drop the in-memory mirror, exactly as a process restart does. The next
 *  hydrate reloads it from the database. */
export function resetSelfHealCache(): void {
  cache.clear();
  hydrated = false;
  lastPrunedAt = 0;
}
