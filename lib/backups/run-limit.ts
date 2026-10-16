// Caps backup runs and restore drills in flight in this process, across overlapping ticks and manual starts.

import { AsyncLocalStorage } from "node:async_hooks";

type Waiter = { weight: number; limit: number; grant: () => void };
type SlotState = { active: number; waiting: Waiter[] };
/** The slots the current run holds. */
type Held = { weight: number; limit: number };

// Must live on globalThis; Next duplicates module state across bundles.
const globalForSlots = globalThis as unknown as {
  __vardo_backup_slot_pool?: SlotState;
  __vardo_backup_slot_held?: AsyncLocalStorage<Held>;
};
const slots: SlotState = (globalForSlots.__vardo_backup_slot_pool ??= { active: 0, waiting: [] });
const heldSlots = (globalForSlots.__vardo_backup_slot_held ??= new AsyncLocalStorage<Held>());

/** Grants waiters in order while the head fits. */
function grant(): void {
  while (slots.waiting.length > 0) {
    const head = slots.waiting[0];
    if (slots.active + head.weight > head.limit) return;
    slots.waiting.shift();
    slots.active += head.weight;
    head.grant();
  }
}

function claim(weight: number, limit: number): Promise<void> {
  return new Promise((resolve) => {
    slots.waiting.push({ weight, limit, grant: resolve });
    grant();
  });
}

/** Concurrent backups and drills: the deploy concurrency, capped by what fits in this process's memory. */
export async function backupSlotLimit(): Promise<number> {
  const { loadResourceSettings, maxBackupConcurrency } = await import("@/lib/resources/host");
  await loadResourceSettings();
  return maxBackupConcurrency();
}

/** Runs `fn` once fewer than `limit` others hold a slot. FIFO. A run already in a slot keeps it. */
export async function withBackupSlot<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  if (heldSlots.getStore()) return fn();
  const held: Held = { weight: 1, limit: Math.max(1, limit) };
  await claim(1, held.limit);
  try {
    return await heldSlots.run(held, fn);
  } finally {
    slots.active -= held.weight;
    grant();
  }
}

/** `withBackupSlot` at this process's slot limit. */
export async function withSizedBackupSlot<T>(fn: () => Promise<T>): Promise<T> {
  return withBackupSlot(await backupSlotLimit(), fn);
}

/** Whether any run holds or waits for a slot. */
export function backupSlotsBusy(): boolean {
  return slots.active > 0 || slots.waiting.length > 0;
}
