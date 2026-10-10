import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("keeps restarts seen in this process for the grace period", () => {
    markActivity("a1", now - 5 * MIN);
    markActivity("a2", now - QUIET_GRACE_MS - MIN);
    expect(activityWindows(now).map((w) => w.appId)).toEqual(["a1"]);
    expect(activityWindows(now + QUIET_GRACE_MS)).toEqual([]);
  });
});
