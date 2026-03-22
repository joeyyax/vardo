import Redis from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:6379";

// Per-process cap — single-node assumption. This will not distribute across
// multiple instances; each process maintains its own independent counter.
const MAX_SUBSCRIBERS = 200;
const WARN_THRESHOLD = 180;

// ---------------------------------------------------------------------------
// Publish client — shared, reused across all publishEvent calls
// ---------------------------------------------------------------------------
const globalForPub = globalThis as unknown as { redisPub: Redis | undefined };
const publishClient =
  globalForPub.redisPub ??
  new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
if (process.env.NODE_ENV !== "production") {
  globalForPub.redisPub = publishClient;
}

export async function publishEvent(
  channel: string,
  data: Record<string, unknown>,
) {
  await publishClient.publish(channel, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Shared subscriber — single PSUBSCRIBE connection with in-process fan-out
// ---------------------------------------------------------------------------

type MessageCallback = (data: Record<string, unknown>) => void;

const globalForSub = globalThis as unknown as {
  redisSubState: SubscriberState | undefined;
};

interface SubscriberState {
  client: Redis;
  listeners: Map<string, Set<MessageCallback>>;
  subscriberCount: number;
  patterns: Set<string>;
}

function getOrCreateState(): SubscriberState {
  if (globalForSub.redisSubState) return globalForSub.redisSubState;

  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  client.on("pmessage", (_pattern: string, channel: string, message: string) => {
    const state = globalForSub.redisSubState;
    if (!state) return;

    const callbacks = state.listeners.get(channel);
    if (!callbacks || callbacks.size === 0) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message);
    } catch {
      return; // skip malformed messages
    }

    for (const cb of callbacks) {
      try {
        cb(parsed);
      } catch {
        // individual callback failure should not break others
      }
    }
  });

  client.on("error", (err) => {
    console.error("[events] Redis subscriber error:", err.message);
  });

  const state: SubscriberState = {
    client,
    listeners: new Map(),
    subscriberCount: 0,
    patterns: new Set(),
  };

  globalForSub.redisSubState = state;
  return state;
}

/**
 * Derive the PSUBSCRIBE pattern from a channel name.
 *
 * Channels must follow the `prefix:id` format (colon-separated), e.g.
 * `"app:abc123"` or `"org:xyz"`. The function returns the wildcard pattern
 * for the prefix — `"app:*"` or `"org:*"` — used for PSUBSCRIBE so that a
 * single Redis subscription covers all IDs under that prefix.
 *
 * If no colon is present the channel is returned unchanged (exact match).
 */
function patternFor(channel: string): string {
  const colon = channel.indexOf(":");
  if (colon === -1) return channel;
  return channel.substring(0, colon + 1) + "*";
}

/**
 * Subscribe to a channel. Returns an unsubscribe function.
 *
 * Internally, all subscriptions share a single Redis connection using
 * PSUBSCRIBE on prefix patterns (e.g. `app:*`). Messages are routed
 * to per-channel callback sets in-process.
 */
export function subscribe(
  channel: string,
  onMessage: MessageCallback,
): () => void {
  const state = getOrCreateState();

  if (state.subscriberCount >= MAX_SUBSCRIBERS) {
    throw new Error(
      `[events] Max subscriber cap (${MAX_SUBSCRIBERS}) reached — rejecting subscription to ${channel}`,
    );
  }

  state.subscriberCount++;

  if (state.subscriberCount >= WARN_THRESHOLD) {
    console.warn(
      `[events] Approaching subscriber cap: ${state.subscriberCount}/${MAX_SUBSCRIBERS}`,
    );
  }

  // Register the callback for this specific channel
  let set = state.listeners.get(channel);
  if (!set) {
    set = new Set();
    state.listeners.set(channel, set);
  }
  set.add(onMessage);

  // Ensure we're PSUBSCRIBE'd to the matching pattern
  const pattern = patternFor(channel);
  if (!state.patterns.has(pattern)) {
    state.patterns.add(pattern);
    state.client.psubscribe(pattern).catch((err) => {
      console.error(
        `[events] Failed to PSUBSCRIBE to ${pattern}:`,
        err.message,
      );
    });
  }

  // Return unsubscribe function
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;

    state.subscriberCount--;

    const callbacks = state.listeners.get(channel);
    if (callbacks) {
      callbacks.delete(onMessage);
      if (callbacks.size === 0) {
        state.listeners.delete(channel);
      }
    }

    // Don't punsubscribe the pattern — other channels may share it,
    // and the overhead of an idle pattern subscription is negligible.
  };
}

// ---------------------------------------------------------------------------
// Channel naming conventions
// ---------------------------------------------------------------------------

export function appChannel(appId: string) {
  return `app:${appId}`;
}

export function orgChannel(orgId: string) {
  return `org:${orgId}`;
}

// ---------------------------------------------------------------------------
// Cleanup on process exit
// ---------------------------------------------------------------------------

function cleanup() {
  const state = globalForSub.redisSubState;
  if (state) {
    state.client.disconnect();
    state.listeners.clear();
    state.patterns.clear();
    state.subscriberCount = 0;
    globalForSub.redisSubState = undefined;
  }
  publishClient.disconnect();
}

process.once("SIGTERM", cleanup);
process.once("SIGINT", cleanup);
