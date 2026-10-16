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

function claim(weight: number, limit: number, front = false): Promise<void> {
  return new Promise((resolve) => {
    const waiter = { weight, limit, grant: resolve };
    if (front) slots.waiting.unshift(waiter);
    else slots.waiting.push(waiter);
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

/**
 * Inside a slot, holds `weight` slots while `fn` runs, at most the limit. Waits at the head of the line
 * holding none, so two runs growing at once can't deadlock. Outside a slot, runs `fn` as is.
 */
export async function withSlotWeight<T>(weight: number, fn: () => Promise<T>): Promise<T> {
  const held = heldSlots.getStore();
  const want = held ? Math.min(Math.ceil(weight), held.limit) : 0;
  if (!held || want <= held.weight) return fn();
  const was = held.weight;
  slots.active -= was;
  held.weight = 0;
  await claim(want, held.limit, true);
  held.weight = want;
  try {
    return await fn();
  } finally {
    slots.active -= want - was;
    held.weight = was;
    grant();
  }
}

/** Whether any run holds or waits for a slot. */
export function backupSlotsBusy(): boolean {
  return slots.active > 0 || slots.waiting.length > 0;
}
