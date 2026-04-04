// ---------------------------------------------------------------------------
// Redis Streams type definitions
// ---------------------------------------------------------------------------

/** A single entry from a Redis Stream (XRANGE / XREAD / XREADGROUP result). */
export type StreamEntry = {
  /** Redis stream entry ID (e.g. "1234567890-0") */
  id: string;
  /** Key-value fields stored in the entry */
  fields: Record<string, string>;
};

/** Toast tiers determine rendering and persistence behavior. */
export type ToastTier = "temp" | "progress" | "persistent";

/** A toast event sent to a user's toast stream. */
export type ToastEvent = {
  /** Unique ID for this toast (progress toasts update in-place by toastId) */
  toastId: string;
  tier: ToastTier;
  type: string;
  title: string;
  message: string;
  /** Progress percentage (0-100) for progress toasts */
  progress?: number;
  /** Current status for progress toasts */
  status?: "running" | "complete" | "failed";
  /** Deep link URL for persistent toasts */
  actionUrl?: string;
  /** Action label for persistent toasts */
  actionLabel?: string;
};

/** Options for reading a stream. */
export type ReadStreamOptions = {
  /** Start reading from this ID (exclusive). Defaults to "0" (beginning). */
  fromId?: string;
  /** Block timeout in ms for live tailing. 0 = don't block. Defaults to 5000. */
  blockMs?: number;
  /** Stop signal — when aborted, the generator returns. */
  signal?: AbortSignal;
};

/** Options for consuming as a group. */
export type ConsumeGroupOptions = {
  /** Consumer group name */
  group: string;
  /** Consumer name (unique per process) */
  consumer: string;
  /** Stream keys to consume from */
  keys: string[];
  /** Handler called for each entry. Must resolve to ACK, reject to NACK. */
  handler: (key: string, entry: StreamEntry) => Promise<void>;
  /** Block timeout in ms. Defaults to 5000. */
  blockMs?: number;
  /** Max entries per XREADGROUP call. Defaults to 10. */
  count?: number;
  /** Stop signal — when aborted, the consumer stops. */
  signal?: AbortSignal;
};
