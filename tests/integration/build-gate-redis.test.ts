// The build gate's Lua against a real Redis: FIFO, uniform slots, the sweep hold, lapsed leases and dead waiters.
// Skips without a Redis at REDIS_URL or localhost:7200.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", () => ({ db: {} }));

const { redisBuildStore } = await import("@/lib/docker/build-gate");

async function connect(): Promise<Redis | null> {
  const client = new Redis(process.env.REDIS_URL || "redis://localhost:7200", {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

const client = await connect();

describe.skipIf(!client)("build gate on Redis", () => {
  const prefix = `test:build-gate:${process.pid}:${Date.now()}`;
  const keys = {
    queue: `${prefix}:queue`,
    seen: `${prefix}:seen`,
    running: `${prefix}:running`,
    hold: `${prefix}:hold`,
    admits: `${prefix}:admits`,
  };
  const store = redisBuildStore(keys, client! as never);

  beforeEach(async () => {
    await client!.del(...Object.values(keys));
  });

  afterAll(async () => {
    await client!.del(...Object.values(keys));
    client!.disconnect();
  });

  it("admits the first build alone and holds the builder for its sweep", async () => {
    expect(await store.tryAcquire("a", 2)).toMatchObject({ alone: true });
    expect(await client!.get(keys.hold)).toBe("sweep:a");
    expect(await store.tryAcquire("b", 2)).toBeNull();
    await store.endSweep();
    expect(await store.tryAcquire("b", 2)).toMatchObject({ alone: false });
  });

  it("runs one build at a time at a limit of one", async () => {
    await store.tryAcquire("a", 1);
    await store.endSweep();
    expect(await store.tryAcquire("b", 1)).toBeNull();
    await store.release("a", false);
    expect(await store.tryAcquire("b", 1)).not.toBeNull();
  });

  it("serves the queue in order", async () => {
    await store.tryAcquire("a", 1);
    await store.endSweep();
    expect(await store.tryAcquire("c", 1)).toBeNull();
    expect(await store.tryAcquire("d", 1)).toBeNull();
    await store.release("a", false);
    expect(await store.tryAcquire("d", 1)).toBeNull();
    expect(await store.tryAcquire("c", 1)).not.toBeNull();
    expect(await store.place("d")).toEqual({ ahead: 0, total: 1 });
  });

  it("frees a lapsed lease and holds the builder for a sweep", async () => {
    await client!.zadd(keys.running, Date.now() - 1000, "dead");
    expect(await store.tryAcquire("a", 1)).toMatchObject({ alone: true });
    expect(await client!.zscore(keys.running, "dead")).toBeNull();
    expect(await client!.get(keys.hold)).toBe("sweep:a");
  });

  it("lets nothing join after a build ends badly until the builder empties", async () => {
    await store.tryAcquire("a", 3);
    await store.endSweep();
    await store.tryAcquire("b", 3);
    await store.release("b", true);
    expect(await store.tryAcquire("c", 3)).toBeNull();
    await store.release("a", false);
    expect(await store.tryAcquire("c", 3)).toMatchObject({ alone: true });
  });

  it("drops a head whose process stopped polling", async () => {
    await client!.rpush(keys.queue, "ghost");
    await client!.hset(keys.seen, "ghost", String(Date.now() - 60_000));
    expect(await store.tryAcquire("a", 1)).not.toBeNull();
    expect(await client!.lpos(keys.queue, "ghost")).toBeNull();
  });

  it("tells a build whether anyone was admitted while it ran", async () => {
    const a = await store.tryAcquire("a", 2);
    await store.endSweep();
    expect(await store.release("a", false)).toBe(a!.gen);

    const b = await store.tryAcquire("b", 2);
    await store.endSweep();
    await store.tryAcquire("c", 2);
    expect(await store.release("b", false)).not.toBe(b!.gen);
  });

  it("takes the sweep hold only while nothing runs", async () => {
    await store.tryAcquire("a", 1);
    await store.endSweep();
    expect(await store.claimSweep("x")).toBe(false);
    await store.release("a", true);
    expect(await store.claimSweep("x")).toBe(true);
    expect(await store.tryAcquire("b", 1)).toBeNull();
  });
});
