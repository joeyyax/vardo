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
    started: `${prefix}:started`,
    remote: `${prefix}:remote`,
    target: `${prefix}:target:`,
    ready: `${prefix}:ready`,
  };
  const store = redisBuildStore(keys, client! as never);
  const allKeys = () => [...Object.values(keys), `${keys.target}lh`, `${keys.target}hz`];

  beforeEach(async () => {
    await client!.del(...allKeys());
  });

  afterAll(async () => {
    await client!.del(...allKeys());
    client!.disconnect();
  });

  describe("build targets", () => {
    const lh = { id: "lh", limit: 1 };
    const hz = { id: "hz", limit: 2 };
    const busy = async () => {
      await store.tryAcquire("here", 1);
      await store.endSweep();
    };

    it("takes this host first when it has a slot", async () => {
      expect(await store.tryAcquireAt("a", 1, [lh])).toMatchObject({ target: null, alone: true });
      expect(await client!.zcard(`${keys.target}lh`)).toBe(0);
    });

    it("overflows to targets in order, each up to its limit, then queues", async () => {
      await busy();
      expect(await store.tryAcquireAt("a", 1, [lh, hz])).toMatchObject({ target: "lh" });
      expect(await store.tryAcquireAt("b", 1, [lh, hz])).toMatchObject({ target: "hz" });
      expect(await store.tryAcquireAt("c", 1, [lh, hz])).toMatchObject({ target: "hz" });
      expect(await store.tryAcquireAt("d", 1, [lh, hz])).toBeNull();
      expect(await client!.lrange(keys.queue, 0, -1)).toEqual(["d"]);
      await store.releaseTarget("a", "lh");
      expect(await store.tryAcquireAt("d", 1, [lh, hz])).toMatchObject({ target: "lh" });
      expect(await client!.hlen(keys.remote)).toBe(0);
    });

    it("never sends a build to a target it wasn't offered", async () => {
      await busy();
      expect(await store.tryAcquireAt("a", 1, [])).toBeNull();
      expect(await store.tryAcquire("a", 1)).toBeNull();
      expect(await client!.zcard(`${keys.target}lh`)).toBe(0);
    });

    it("lets a remote-eligible build pass one that can only build here, but not another eligible one", async () => {
      await busy();
      expect(await store.tryAcquireAt("local-only", 1, [])).toBeNull();
      expect(await store.tryAcquireAt("first", 1, [{ id: "lh", limit: 0 }])).toBeNull();
      expect(await store.tryAcquireAt("second", 1, [lh])).toBeNull();
      expect(await store.tryAcquireAt("first", 1, [lh])).toMatchObject({ target: "lh" });
      expect(await client!.lrange(keys.queue, 0, -1)).toEqual(["local-only", "second"]);
    });

    it("drops a dead eligible waiter ahead instead of waiting on it", async () => {
      await busy();
      await store.tryAcquireAt("dead", 1, [{ id: "lh", limit: 0 }]);
      await client!.hset(keys.seen, "dead", String(Date.now() - 60_000));
      await store.tryAcquireAt("live-local", 1, []);
      expect(await store.tryAcquireAt("next", 1, [lh])).toMatchObject({ target: "lh" });
      expect(await client!.lrange(keys.queue, 0, -1)).toEqual(["live-local"]);
    });

    it("frees a target slot whose lease lapsed", async () => {
      await busy();
      await client!.zadd(`${keys.target}lh`, Date.now() - 1000, "dead");
      expect(await store.tryAcquireAt("a", 1, [lh])).toMatchObject({ target: "lh" });
    });

    it("never takes this host for a build that may run only on a target, even with this host idle", async () => {
      expect(await store.tryAcquireAt("remote", 2, [{ id: "lh", limit: 0 }], true)).toBeNull();
      expect(await client!.zcard(keys.running)).toBe(0);
      expect(await store.tryAcquireAt("remote", 2, [lh], true)).toMatchObject({ target: "lh" });
      expect(await client!.zcard(keys.running)).toBe(0);
    });

    it("lets a build for this host pass one waiting only for a target", async () => {
      expect(await store.tryAcquireAt("remote", 1, [{ id: "lh", limit: 0 }], true)).toBeNull();
      expect(await store.tryAcquire("here", 1)).toMatchObject({ target: null });
      expect(await client!.lrange(keys.queue, 0, -1)).toEqual(["remote"]);
    });

    it("keeps a build that may run only on a target behind a live eligible one", async () => {
      await busy();
      expect(await store.tryAcquireAt("first", 1, [{ id: "lh", limit: 0 }])).toBeNull();
      expect(await store.tryAcquireAt("remote", 1, [lh], true)).toBeNull();
      expect(await store.tryAcquireAt("first", 1, [lh])).toMatchObject({ target: "lh" });
    });

    it("drops a dead entry ahead of this host's next build, past one waiting only for a target", async () => {
      await store.tryAcquireAt("remote", 1, [{ id: "lh", limit: 0 }], true);
      await store.tryAcquire("dead", 1).then(() => store.release("dead", false));
      await client!.rpush(keys.queue, "dead");
      await client!.hset(keys.seen, "dead", String(Date.now() - 60_000));
      await store.endSweep();
      expect(await store.tryAcquire("here", 1)).toMatchObject({ target: null });
      expect(await client!.lrange(keys.queue, 0, -1)).toEqual(["remote"]);
    });

    it("lists the builds holding each target's slots", async () => {
      await busy();
      await store.tryAcquireAt("d1:abc", 1, [lh, hz]);
      await store.tryAcquireAt("d2:def", 1, [lh, hz]);
      await client!.zadd(`${keys.target}hz`, Date.now() - 1000, "lapsed");
      expect(await store.targetHolders(["lh", "hz"])).toEqual(["d1:abc", "d2:def"]);
    });

    it("renews a target build's lease on the target's set", async () => {
      await busy();
      await store.tryAcquireAt("a", 1, [lh]);
      const before = Number(await client!.zscore(`${keys.target}lh`, "a"));
      await new Promise((r) => setTimeout(r, 20));
      await store.renew("a", "lh");
      expect(Number(await client!.zscore(`${keys.target}lh`, "a"))).toBeGreaterThan(before);
      expect(await client!.zscore(keys.running, "a")).toBeNull();
    });
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

  it("moves a deployment's waiting build to the head, and nothing else", async () => {
    await store.tryAcquire("run:1", 1);
    await store.endSweep();
    for (const id of ["dep-a:x1", "dep-b:x2", "dep-c:x3"]) expect(await store.tryAcquire(id, 1)).toBeNull();

    expect(await store.bump("dep-c")).toBe(true);
    expect(await client!.lrange(keys.queue, 0, -1)).toEqual(["dep-c:x3", "dep-a:x1", "dep-b:x2"]);
    expect(await store.place("dep-c:x3")).toEqual({ ahead: 0, total: 3 });
    // A prefix of another deployment's id doesn't match.
    expect(await store.bump("dep")).toBe(false);
    expect(await store.bump("dep-z")).toBe(false);

    await store.release("run:1", false);
    expect(await store.tryAcquire("dep-a:x1", 1)).toBeNull();
    expect(await store.tryAcquire("dep-c:x3", 1)).not.toBeNull();
  });

  it("reports the queue and when each running build was admitted", async () => {
    const before = Date.now();
    await store.tryAcquire("run:1", 2);
    await store.endSweep();
    await store.tryAcquire("run:2", 2);
    await store.tryAcquire("held:1", 2);
    await store.release("run:2", false);
    const snap = await store.snapshot();
    expect(snap.running.map((r) => r.id)).toEqual(["run:1"]);
    expect(snap.running[0].since).toBeGreaterThanOrEqual(before - 1000);
    expect(await client!.hexists(keys.started, "run:2")).toBe(0);
  });

  it("frees a lapsed lease and holds the builder for a sweep", async () => {
    await client!.zadd(keys.running, Date.now() - 1000, "dead");
    await client!.hset(keys.started, "dead", String(Date.now() - 60_000));
    expect(await store.tryAcquire("a", 1)).toMatchObject({ alone: true });
    expect(await client!.zscore(keys.running, "dead")).toBeNull();
    expect(await client!.get(keys.hold)).toBe("sweep:a");
    // A lapsed build's admission time goes once the builder empties.
    expect(await client!.hkeys(keys.started)).toEqual(["a"]);
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
