import Redis from "ioredis";

const globalForRedis = globalThis as unknown as { redis: Redis | undefined };

function createRedisClient() {
  const url = process.env.REDIS_URL || "redis://localhost:9200";
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
}

export const redis = globalForRedis.redis ?? createRedisClient();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
