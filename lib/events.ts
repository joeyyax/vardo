import Redis from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:6379";

// Publish an event — use the shared redis client
export async function publishEvent(channel: string, data: Record<string, unknown>) {
  const pub = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
  try {
    await pub.publish(channel, JSON.stringify(data));
  } finally {
    pub.disconnect();
  }
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
export function projectChannel(projectId: string) {
  return `project:${projectId}`;
}

export function orgChannel(orgId: string) {
  return `org:${orgId}`;
}
