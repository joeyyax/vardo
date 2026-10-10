// Keyed cooldowns: per-key backoff, server-requested holds and the Redis store's fallback.

import { describe, it, expect, vi } from "vitest";
import { KeyedCooldown, MemoryCooldownStore, RedisCooldownStore } from "@/lib/net/cooldown";

const now = 1_000_000;

describe("KeyedCooldown", () => {
  it("backs off per key and clears on success", async () => {
    const c = new KeyedCooldown({ baseMs: 1_000, maxMs: 10_000 });
    expect(await c.fail("a.example.com", { now })).toBe(1_000);
    expect(await c.fail("a.example.com", { now })).toBe(2_000);
    expect(await c.remaining("a.example.com", now)).toBe(2_000);
    expect(await c.blocked("b.example.com", now)).toBe(false);
    await c.succeed("a.example.com");
    expect(await c.blocked("a.example.com", now)).toBe(false);
    expect(await c.fail("a.example.com", { now })).toBe(1_000);
  });

  it("caps the wait", async () => {
    const c = new KeyedCooldown({ baseMs: 1_000, maxMs: 3_000 });
    for (let i = 0; i < 5; i++) await c.fail("k", { now });
    expect(await c.fail("k", { now })).toBe(3_000);
  });

  it("jitters between the base and the ceiling", async () => {
    const low = new KeyedCooldown({ baseMs: 1_000, maxMs: 60_000, jitter: "full", random: () => 0 });
    const high = new KeyedCooldown({ baseMs: 1_000, maxMs: 60_000, jitter: "full", random: () => 1 });
    for (let i = 0; i < 3; i++) {
      await low.fail("k", { now });
      await high.fail("k", { now });
    }
    expect(await low.fail("k", { now })).toBe(1_000);
    expect(await high.fail("k", { now })).toBe(8_000);
  });

  it("takes a Retry-After as a floor, capped at maxHoldMs", async () => {
    const c = new KeyedCooldown({ baseMs: 1_000, maxMs: 10_000, maxHoldMs: 30_000 });
    expect(await c.fail("k", { now, retryAfterMs: 5_000 })).toBe(5_000);
    expect(await c.fail("j", { now, retryAfterMs: 3_600_000 })).toBe(30_000);
  });

  it("holds a key for a rate-limit reset without counting a failure", async () => {
    const c = new KeyedCooldown({ baseMs: 1_000, maxMs: 10_000, maxHoldMs: 60_000 });
    expect(await c.hold("installation:1", 45_000, now)).toBe(45_000);
    expect(await c.blocked("installation:1", now + 44_000)).toBe(true);
    expect(await c.fail("installation:1", { now })).toBe(1_000);
  });

  it("never shortens a longer hold", async () => {
    const c = new KeyedCooldown({ baseMs: 1_000, maxMs: 10_000, maxHoldMs: 60_000 });
    await c.hold("k", 50_000, now);
    await c.fail("k", { now });
    expect(await c.remaining("k", now)).toBe(50_000);
    expect(await c.hold("k", 10_000, now)).toBe(50_000);
  });
});

function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (data.delete(key) ? 1 : 0)),
  };
}

describe("RedisCooldownStore", () => {
  it("shares a cooldown between instances", async () => {
    const client = fakeRedis();
    const a = new KeyedCooldown({ baseMs: 1_000, maxMs: 10_000, store: new RedisCooldownStore(client as never, "t:") });
    const b = new KeyedCooldown({ baseMs: 1_000, maxMs: 10_000, store: new RedisCooldownStore(client as never, "t:") });
    await a.fail("git.example.com", { now });
    expect(client.data.has("t:git.example.com")).toBe(true);
    expect(client.set.mock.calls[0].slice(2)).toEqual(["PX", 11_000]);
    expect(await b.blocked("git.example.com", now)).toBe(true);
    await b.succeed("git.example.com");
    expect(await a.blocked("git.example.com", now)).toBe(false);
  });

  it("falls back to memory while Redis is down", async () => {
    const down = new Error("connection refused");
    const client = {
      get: vi.fn().mockRejectedValue(down),
      set: vi.fn().mockRejectedValue(down),
      del: vi.fn().mockRejectedValue(down),
    };
    const c = new KeyedCooldown({ baseMs: 1_000, maxMs: 10_000, store: new RedisCooldownStore(client as never) });
    await c.fail("k", { now });
    expect(await c.blocked("k", now)).toBe(true);
    await c.succeed("k");
    expect(await c.blocked("k", now)).toBe(false);
  });

  it("ignores a corrupt entry", async () => {
    const client = fakeRedis();
    client.data.set("cooldown:k", "not json");
    const store = new RedisCooldownStore(client as never);
    expect(await store.get("k")).toBeNull();
  });
});

describe("MemoryCooldownStore", () => {
  it("forgets an entry after its ttl", async () => {
    vi.useFakeTimers();
    const store = new MemoryCooldownStore();
    await store.set("k", { failures: 1, until: 0 }, 1_000);
    expect(await store.get("k")).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(await store.get("k")).toBeNull();
    vi.useRealTimers();
  });
});
