// OOM kills web records during deploys reach the alert pass in the worker through Redis.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRedis } from "../../helpers/fake-redis";

const fake = vi.hoisted(() => ({ redis: null as unknown as ReturnType<typeof createFakeRedis>, now: 0 }));

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/redis", () => ({
  get redis() {
    return fake.redis;
  },
}));

const { OOM_HOLD_MS, markOomSent, oomRecordKey, recordOomKill, resetOomKills, saveOomAutotune, sharedOomKills } = await import("@/lib/alerts/oom");

const T0 = Date.parse("2026-10-10T09:46:00Z");

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  fake.now = T0;
  fake.redis = createFakeRedis(() => fake.now);
  resetOomKills();
});

afterEach(() => vi.useRealTimers());

describe("shared OOM kills", () => {
  it("merges kills from two processes into one record the alert pass reads", async () => {
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "shop-blue-web-1", containerId: "c1", kind: "oom-limit", path: "process" }, T0);
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "shop-blue-web-1", containerId: "c2", kind: "oom-host", path: "exit", restartCount: 3 }, T0 + 1000);
    await settle();
    // The alert pass runs in another process: nothing local.
    resetOomKills();

    const [record] = await sharedOomKills(T0 + 2000);
    expect(record).toMatchObject({ organizationId: "org1", appId: "a1", kills: 2, hostKill: true, path: "exit", restartBaseline: 3, firstAt: T0, lastAt: T0 + 1000 });
    expect([...record.containers]).toEqual([["shop-blue-web-1", 2]]);
    expect([...record.containerIds].sort()).toEqual(["c1", "c2"]);
    expect(record.sent).toBeUndefined();
    expect(record.autotune).toBeUndefined();
  });

  it("keeps the sent flag and the auto-adjust note across passes", async () => {
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c", kind: "oom-limit" }, T0);
    await settle();
    const [first] = await sharedOomKills(T0);
    first.autotune = { kind: "held", reason: "rate-limited" };
    await saveOomAutotune(first);
    await markOomSent(first);

    const [again] = await sharedOomKills(T0 + 1000);
    expect(again.sent).toBe(true);
    expect(again.autotune).toEqual({ kind: "held", reason: "rate-limited" });
  });

  it("records an auto-adjust that did nothing as decided", async () => {
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c", kind: "oom-limit" }, T0);
    await settle();
    const [first] = await sharedOomKills(T0);
    first.autotune = null;
    await saveOomAutotune(first);
    expect((await sharedOomKills(T0))[0].autotune).toBeNull();
  });

  it("drops a record once the hold window passes the last kill", async () => {
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c", kind: "oom-limit" }, T0);
    await settle();
    fake.now = T0 + OOM_HOLD_MS + 1;
    expect(await sharedOomKills(fake.now)).toEqual([]);
  });

  it("doesn't leave a key without a TTL when the record lapsed before it was marked sent", async () => {
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c", kind: "oom-limit" }, T0);
    await settle();
    const [record] = await sharedOomKills(T0);
    fake.now = T0 + OOM_HOLD_MS + 1;
    await markOomSent(record);
    expect(await fake.redis.pttl(oomRecordKey("org1", "a1"))).toBeGreaterThan(0);
    expect(await sharedOomKills(fake.now)).toEqual([]);
  });

  it("falls back to this process's kills when Redis can't be read", async () => {
    fake.redis.ctl.down = true;
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c", kind: "oom-limit" }, T0);
    await settle();
    expect((await sharedOomKills(T0)).map((r) => r.appId)).toEqual(["a1"]);
  });

  it("retries a kill Redis refused, so the other process's alert pass still sees it", async () => {
    vi.useFakeTimers();
    fake.redis.ctl.down = true;
    recordOomKill("org1", { appId: "a1", appName: "Shop", containerName: "c", kind: "oom-limit" }, T0);
    await settle();
    fake.redis.ctl.down = false;
    resetOomKills();
    expect(await sharedOomKills(T0)).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await sharedOomKills(T0)).map((r) => r.kills)).toEqual([1]);
  });
});
