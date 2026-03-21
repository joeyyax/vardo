import Redis from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:6379";

// Shared publish client — reused across all publishEvent calls
const globalForPub = globalThis as unknown as { redisPub: Redis | undefined };
const publishClient = globalForPub.redisPub ?? new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
if (process.env.NODE_ENV !== "production") {
  globalForPub.redisPub = publishClient;
}

// Publish an event — use the shared redis client
export async function publishEvent(channel: string, data: Record<string, unknown>) {
  await publishClient.publish(channel, JSON.stringify(data));
}

// Subscribe to a channel — returns a cleanup function
// Each subscriber needs its own Redis connection (ioredis requirement)
export function subscribe(
  channel: string,
  onMessage: (data: Record<string, unknown>) => void,
): () => void {
  const sub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });

  sub.subscribe(channel).catch(() => {
    // Connection failed — silently degrade
  });

  sub.on("message", (_ch: string, message: string) => {
    try {
      onMessage(JSON.parse(message));
    } catch {
      // Skip malformed messages
    }
  });

  return () => {
    sub.unsubscribe(channel).catch(() => {});
    sub.disconnect();
  };
}

// Channel naming conventions
export function appChannel(appId: string) {
  return `app:${appId}`;
}

export function orgChannel(orgId: string) {
  return `org:${orgId}`;
}
