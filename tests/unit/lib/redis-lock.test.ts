import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/redis", () => ({
  redis: {
    set: vi.fn(async (key: string, value: string, _px: string, _ttl: number, nx: string) => {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    // Mirrors the compare-and-delete script.
    eval: vi.fn(async (_script: string, _n: number, key: string, token: string) => {
      if (store.get(key) !== token) return 0;
      store.delete(key);
      return 1;
    }),
  },
}));

import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { redis } from "@/lib/redis";

describe("redis lock", () => {
  beforeEach(() => store.clear());

  it("hands each owner its own token and refuses a second acquire", async () => {
    const token = await acquireLock("k", 1000);
    expect(token).toEqual(expect.any(String));
    expect(await acquireLock("k", 1000)).toBeNull();
  });

  it("a stale owner's release leaves the next owner's lock alone", async () => {
    const first = (await acquireLock("k", 1000))!;
    // The first owner's TTL lapsed and a second owner took the key.
    store.delete("k");
    const second = (await acquireLock("k", 1000))!;

    expect(await releaseLock("k", first)).toBe(false);
    expect(store.get("k")).toBe(second);
    expect(await releaseLock("k", second)).toBe(true);
    expect(store.has("k")).toBe(false);
  });

  it("releases through a compare-and-delete script, not a bare DEL", async () => {
    const token = (await acquireLock("k", 1000))!;
    await releaseLock("k", token);
    const [script] = vi.mocked(redis.eval).mock.calls[0] as unknown as [string];
    expect(script).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
  });
});

describe.skipIf(!process.env.TEST_REDIS_URL)("redis lock against a real Redis", () => {
  it("compare-and-delete runs as Lua", async () => {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(process.env.TEST_REDIS_URL!);
    const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
    const key = `test:lock:${Date.now()}`;
    try {
      await client.set(key, "mine", "PX", 5000, "NX");
      expect(await client.eval(script, 1, key, "theirs")).toBe(0);
      expect(await client.get(key)).toBe("mine");
      expect(await client.eval(script, 1, key, "mine")).toBe(1);
      expect(await client.get(key)).toBeNull();
    } finally {
      await client.del(key);
      client.disconnect();
    }
  });
});
