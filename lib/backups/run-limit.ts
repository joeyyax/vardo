// Caps backup runs and restore drills in flight in this process, across overlapping ticks.

let active = 0;
const waiting: (() => void)[] = [];

/** Runs `fn` once fewer than `limit` others hold a slot. FIFO. */
export async function withBackupSlot<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  while (active >= Math.max(1, limit)) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

