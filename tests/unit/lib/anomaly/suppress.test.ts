import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeRedis } from "../../helpers/fake-redis";

vi.mock("@/lib/redis", async () => ({ redis: (await import("@/tests/unit/helpers/fake-redis")).createFakeRedis() }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { QUIET_GRACE_MS, activityWindows, inQuietWindow, markActivity, quietApps, resetActivity } = await import("@/lib/anomaly/suppress");

const MIN = 60_000;
const now = 1_000 * MIN;

beforeEach(() => resetActivity());

describe("quiet windows", () => {
  it("covers running work and its grace period", () => {
    expect(inQuietWindow([{ appId: "a", start: now - 5 * MIN, end: null }], now)).toBe(true);
    expect(inQuietWindow([{ appId: "a", start: now - 60 * MIN, end: now - 10 * MIN }], now)).toBe(true);
    expect(inQuietWindow([{ appId: "a", start: now - 60 * MIN, end: now - QUIET_GRACE_MS }], now)).toBe(false);
  });

  it("stops counting work that never recorded an end", () => {
    expect(inQuietWindow([{ appId: "a", start: now - 7 * 60 * MIN, end: null }], now)).toBe(false);
  });

  it("ignores work that hasn't started", () => {
    expect(inQuietWindow([{ appId: "a", start: now + MIN, end: null }], now)).toBe(false);
  });

  it("names only the apps whose windows cover now", () => {
    const quiet = quietApps(
      [
        { appId: "deploying", start: now - MIN, end: null },
        { appId: "backed-up", start: now - 40 * MIN, end: now - 20 * MIN },
        { appId: "long-ago", start: now - 120 * MIN, end: now - 90 * MIN },
      ],
      now,
    );
    expect([...quiet].sort()).toEqual(["backed-up", "deploying"]);
  });

  it("keeps restarts seen in this process for the grace period", async () => {
    markActivity("a1", now - 5 * MIN);
    markActivity("a2", now - QUIET_GRACE_MS - MIN);
    expect((await activityWindows(now)).map((w) => w.appId)).toEqual(["a1"]);
    expect(await activityWindows(now + QUIET_GRACE_MS)).toEqual([]);
  });

  it("sees restarts another process marked, through Redis", async () => {
    markActivity("a3", now + 2 * QUIET_GRACE_MS);
    await new Promise((r) => setImmediate(r));
    resetActivity();
    expect((await activityWindows(now + 2 * QUIET_GRACE_MS + MIN)).map((w) => w.appId)).toEqual(["a3"]);
  });

  it("uses this process's restarts when Redis is down", async () => {
    const fake = (await import("@/lib/redis")).redis as unknown as FakeRedis;
    fake.ctl.down = true;
    try {
      markActivity("a4", now + 4 * QUIET_GRACE_MS);
      expect((await activityWindows(now + 4 * QUIET_GRACE_MS + MIN)).map((w) => w.appId)).toEqual(["a4"]);
    } finally {
      fake.ctl.down = false;
    }
  });
});
