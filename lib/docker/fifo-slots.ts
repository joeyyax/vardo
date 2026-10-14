// FIFO wait for a slot in a Redis-backed queue, used by the build gate.

/** One queue's storage: take the slot when this id heads the queue and one is free, read its place, leave. */
export type SlotStore<T> = {
  /** The acquired slot, or null while it must wait. Throws when the store can't answer. */
  tryAcquire(id: string, limit: number): Promise<T | null>;
  /** Entries ahead of this id and in the whole queue, "absent" when it isn't queued, "unknown" when the store didn't answer. */
  place(id: string): Promise<SlotPlace | "absent" | "unknown">;
  remove(id: string): Promise<void>;
};

export type SlotPlace = { ahead: number; total: number };

export type FifoWaitOpts<T> = {
  /** Read on every attempt, so a changed limit applies to the next poll. */
  limit: () => number | Promise<number>;
  signal?: AbortSignal;
  /** Called on every read of the place, so a listener can refresh what depends on time. */
  onPosition?: (place: SlotPlace) => void;
  timeoutMs: number;
  pollMs: number;
  /** How often the place in line is read. */
  positionPollMs: number;
  messages: { aborted: string; timedOut: string; removed: string };
  /** What a store error turns into, such as proceeding without a limit. */
  onStoreError: (err: unknown) => Promise<T> | T;
};

/** Poll until `id` heads the queue with a free slot, then take it. Throws on abort, timeout or removal, leaving the queue. */
export async function waitForFifoSlot<T>(store: SlotStore<T>, id: string, opts: FifoWaitOpts<T>): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let positionReadAt = 0;

  while (true) {
    if (Date.now() - positionReadAt >= opts.positionPollMs) {
      positionReadAt = Date.now();
      const place = await store.place(id);
      // Taken out of the list, as by the sweeper: it can never reach the head.
      if (place === "absent") throw new Error(opts.messages.removed);
      if (typeof place === "object") {
        try {
          opts.onPosition?.(place);
        } catch { /* a listener never stalls the queue */ }
      }
    }

    if (opts.signal?.aborted) {
      await store.remove(id).catch(() => {});
      throw new Error(opts.messages.aborted);
    }

    if (Date.now() >= deadline) {
      await store.remove(id).catch(() => {});
      throw new Error(opts.messages.timedOut);
    }

    try {
      const slot = await store.tryAcquire(id, await opts.limit());
      if (slot !== null) return slot;
    } catch (err) {
      return opts.onStoreError(err);
    }

    const jitter = Math.random() * opts.pollMs;
    await new Promise<void>((resolve) => setTimeout(resolve, opts.pollMs + jitter));
  }
}
