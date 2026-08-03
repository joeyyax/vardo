// ---------------------------------------------------------------------------
// Where a stopped deploy's major change is kept until someone resolves it.
//
// A toast dies with the tab and the deploy log scrolls away, so the block
// outlives both: the app's updates panel reads it back and opens the migration
// dialog on it. Cleared by the next successful deploy of the same app.
// ---------------------------------------------------------------------------

import { redis } from "@/lib/redis";
import type { MajorGateBlock } from "./major-gate";

const KEY_PREFIX = "image-updates:major-gate:";
/** Long enough to survive a weekend and a restart; the deploy clears it sooner. */
const TTL_SECONDS = 30 * 24 * 60 * 60;

function key(appId: string): string {
  return `${KEY_PREFIX}${appId}`;
}

export async function writeMajorGateBlock(block: MajorGateBlock): Promise<void> {
  try {
    await redis.set(key(block.appId), JSON.stringify(block), "EX", TTL_SECONDS);
  } catch {
    // The block is a convenience surface; the deploy already failed loudly.
  }
}

export async function readMajorGateBlock(appId: string): Promise<MajorGateBlock | null> {
  try {
    const raw = await redis.get(key(appId));
    return raw ? (JSON.parse(raw) as MajorGateBlock) : null;
  } catch {
    return null;
  }
}

export async function clearMajorGateBlock(appId: string): Promise<void> {
  try {
    await redis.del(key(appId));
  } catch {
    // Best effort.
  }
}
