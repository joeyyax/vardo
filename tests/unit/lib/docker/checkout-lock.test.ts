import { describe, it, expect } from "vitest";
import { acquireCheckoutLock, type LockRedis } from "@/lib/docker/checkout-lock";

/** An in-memory SET NX with the release and renew scripts. */
function fakeRedis(): LockRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async set(key, value) {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async eval(script, _n, key, token) {
      if (store.get(key) !== token) return 0;
      if (script.includes("del")) store.delete(key);
      return 1;
    },
  };
}

const quiet = { log: () => {} };

describe("acquireCheckoutLock", () => {
  it("runs one holder per app at a time, in order", async () => {
    const redis = fakeRedis();
    const order: string[] = [];
    const hold = async (name: string, ms: number) => {
      const lock = await acquireCheckoutLock("app1", { ...quiet, redis: async () => redis });
      order.push(`${name}:in`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:out`);
      await lock.release();
    };
    await Promise.all([hold("prod", 30), hold("preview", 5), hold("staging", 5)]);
    expect(order).toEqual(["prod:in", "prod:out", "preview:in", "preview:out", "staging:in", "staging:out"]);
    expect(redis.store.size).toBe(0);
  });

  it("lets other apps through", async () => {
    const redis = fakeRedis();
    const a = await acquireCheckoutLock("a", { ...quiet, redis: async () => redis });
    const b = await acquireCheckoutLock("b", { ...quiet, redis: async () => redis });
    await Promise.all([a.release(), b.release()]);
  });

  it("waits out a holder in another process and logs that it's waiting", async () => {
    const redis = fakeRedis();
    redis.store.set("deploy:checkout:app2", "other-process");
    const lines: string[] = [];
    setTimeout(() => redis.store.delete("deploy:checkout:app2"), 50);
    const lock = await acquireCheckoutLock("app2", { log: (l) => lines.push(l), redis: async () => redis });
    expect(lines.some((l) => l.includes("Waiting for another deploy"))).toBe(true);
    await lock.release();
  });

  it("times out behind a holder that never lets go, and frees the queue for the next", async () => {
    const redis = fakeRedis();
    redis.store.set("deploy:checkout:app3", "stuck");
    await expect(acquireCheckoutLock("app3", { ...quiet, waitMs: 50, redis: async () => redis })).rejects.toThrow(/Timed out/);
    redis.store.delete("deploy:checkout:app3");
    const lock = await acquireCheckoutLock("app3", { ...quiet, waitMs: 50, redis: async () => redis });
    await lock.release();
  });

  it("stops waiting on abort", async () => {
    const redis = fakeRedis();
    redis.store.set("deploy:checkout:app4", "other");
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);
    await expect(acquireCheckoutLock("app4", { ...quiet, signal: abort.signal, redis: async () => redis })).rejects.toThrow(/aborted/);
  });

  it("falls back to the in-process lock when Redis is down", async () => {
    const lines: string[] = [];
    const down = async (): Promise<LockRedis> => {
      throw new Error("ECONNREFUSED");
    };
    const first = await acquireCheckoutLock("app5", { log: (l) => lines.push(l), redis: down });
    let second = false;
    const pending = acquireCheckoutLock("app5", { log: (l) => lines.push(l), redis: down }).then((l) => {
      second = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBe(false);
    await first.release();
    await (await pending).release();
    expect(lines.some((l) => l.includes("in this process only"))).toBe(true);
  });
});
