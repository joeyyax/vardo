// Caps backup runs and restore drills in flight in this process, across overlapping ticks.

type SlotState = { active: number; waiting: (() => void)[] };

// Must live on globalThis; Next duplicates module state across bundles.
const globalForSlots = globalThis as unknown as { __vardo_backup_slots?: SlotState };
const slots: SlotState = (globalForSlots.__vardo_backup_slots ??= { active: 0, waiting: [] });

/** Runs `fn` once fewer than `limit` others hold a slot. FIFO. */
export async function withBackupSlot<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  while (slots.active >= Math.max(1, limit)) {
    await new Promise<void>((resolve) => slots.waiting.push(resolve));
  }
  slots.active++;
  try {
    return await fn();
  } finally {
    slots.active--;
    slots.waiting.shift()?.();
  }
}

/** Whether any run holds or waits for a slot. */
export function backupSlotsBusy(): boolean {
  return slots.active > 0 || slots.waiting.length > 0;
}
