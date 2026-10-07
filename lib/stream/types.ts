/** A single entry from a Redis Stream (XRANGE / XREAD / XREADGROUP result). */
export type StreamEntry = {
  /** Entry ID, e.g. "1234567890-0". */
  id: string;
  fields: Record<string, string>;
};

/** Toast tiers determine rendering and persistence behavior. */
export type ToastTier = "temp" | "progress" | "persistent";

/** A toast event sent to a user's toast stream. */
export type ToastEvent = {
  /** Progress toasts update in place by toastId. */
  toastId: string;
  tier: ToastTier;
  type: string;
  title: string;
  message: string;
  /** 0-100, for progress toasts. */
  progress?: number;
  status?: "running" | "complete" | "failed";
  /** Deep link for persistent toasts. */
  actionUrl?: string;
  actionLabel?: string;
};

/** Options for reading a stream. */
export type ReadStreamOptions = {
  /** Start reading from this ID (exclusive). Defaults to "0" (beginning). */
  fromId?: string;
  /** Block timeout in ms for live tailing. 0 = don't block. Defaults to 5000. */
  blockMs?: number;
  /** Returns the generator when aborted. */
  signal?: AbortSignal;
};

/** Options for consuming as a group. */
export type ConsumeGroupOptions = {
  group: string;
  /** Unique per process. */
  consumer: string;
  keys: string[];
  /** Handler called for each entry. Must resolve to ACK, reject to NACK. */
  handler: (key: string, entry: StreamEntry) => Promise<void>;
  /** Block timeout in ms. Defaults to 5000. */
  blockMs?: number;
  /** Max entries per XREADGROUP call. Defaults to 10. */
  count?: number;
  signal?: AbortSignal;
};
