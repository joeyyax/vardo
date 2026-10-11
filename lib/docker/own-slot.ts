// This container's blue or green slot, from its compose project label.

import { hostname } from "os";
import type { Slot } from "./slots";

const RETRY_MS = 60_000;

const g = globalThis as unknown as { __vardo_own_slot?: { slot: Slot | null; at: number } };

async function readSlot(): Promise<Slot | null> {
  try {
    const { inspectContainer } = await import("./client");
    const { projectSlot } = await import("./desired-state");
    const info = await inspectContainer(process.env.CONTAINER_ID ?? hostname());
    const slot = projectSlot(info.labels["com.docker.compose.project"]);
    return slot === "blue" || slot === "green" ? slot : null;
  } catch {
    return null;
  }
}

/** Null outside a slot or when Docker can't say; a null is read again after a minute. */
export async function ownSlot(now = Date.now()): Promise<Slot | null> {
  const hit = g.__vardo_own_slot;
  if (hit && (hit.slot !== null || now - hit.at < RETRY_MS)) return hit.slot;
  const slot = await readSlot();
  g.__vardo_own_slot = { slot, at: now };
  return slot;
}

/** Tests only. */
export function resetOwnSlot(): void {
  delete g.__vardo_own_slot;
}
