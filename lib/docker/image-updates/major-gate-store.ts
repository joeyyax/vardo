// Stores a major-gate block until resolved. Cleared by the app's next successful deploy.

import { redis } from "@/lib/redis";
import type { MajorGateBlock } from "./major-gate";

const KEY_PREFIX = "image-updates:major-gate:";
/** Thirty days. */
const TTL_SECONDS = 30 * 24 * 60 * 60;

function key(appId: string): string {
  return `${KEY_PREFIX}${appId}`;
}

export async function writeMajorGateBlock(block: MajorGateBlock): Promise<void> {
  try {
    await redis.set(key(block.appId), JSON.stringify(block), "EX", TTL_SECONDS);
  } catch {
    // Best effort; the deploy already failed.
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
