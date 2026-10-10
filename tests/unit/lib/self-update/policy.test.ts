import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, effectiveChannel, parsePolicy, updatePolicySchema } from "@/lib/self-update/policy";
import { decideTick, isRunActive, verifyStep, VERIFY_WINDOW_MS } from "@/lib/self-update/decide";

const READY = { ready: true as const, reason: "No canary to wait on" };
// 03:30 UTC, inside the default 03:00–05:00 window.
const IN_WINDOW = new Date("2026-10-09T03:30:00Z");
const OUT_OF_WINDOW = new Date("2026-10-09T12:00:00Z");

describe("update policy", () => {
  it("defaults new installs to Notify on main", () => {
    expect(parsePolicy(null)).toEqual(DEFAULT_POLICY);
    expect(effectiveChannel(DEFAULT_POLICY)).toBe("main");
  });

  it("defaults Auto to releases unless a channel is set", () => {
    expect(effectiveChannel({ mode: "auto", channel: null })).toBe("releases");
    expect(effectiveChannel({ mode: "auto", channel: "main" })).toBe("main");
    expect(effectiveChannel({ mode: "notify", channel: "releases" })).toBe("releases");
  });

  it("replaces unreadable fields with defaults", () => {
    const p = parsePolicy({
      mode: "sometimes",
      channel: "nightly",
      window: { start: "25:00", end: "04:00", timezone: "Mars/Olympus" },
      canary: { role: "follower", canaryInstanceId: "", soakHours: 9999 },
    });
    expect(p.mode).toBe("notify");
    expect(p.channel).toBe("main");
    expect(p.window).toEqual({ start: "03:00", end: "04:00", timezone: null });
    expect(p.canary).toEqual({ role: "follower", canaryInstanceId: null, soakHours: 336 });
  });

  it("validates input from the API", () => {
    const ok = { ...DEFAULT_POLICY, mode: "auto", window: { start: "22:00", end: "02:00", timezone: "America/Los_Angeles" } };
    expect(updatePolicySchema.safeParse(ok).success).toBe(true);
    expect(updatePolicySchema.safeParse({ ...ok, window: { ...ok.window, timezone: "Nowhere/Else" } }).success).toBe(false);
    expect(updatePolicySchema.safeParse({ ...ok, window: { ...ok.window, start: "2am" } }).success).toBe(false);
    const follower = { ...ok, canary: { role: "follower", canaryInstanceId: null, soakHours: 24 } };
    expect(updatePolicySchema.safeParse(follower).success).toBe(false);
    expect(updatePolicySchema.safeParse({ ...follower, canary: { ...follower.canary, canaryInstanceId: "inst-a" } }).success).toBe(true);
  });
});

describe("decideTick", () => {
  const base = {
    policy: { ...DEFAULT_POLICY, mode: "auto" as const },
    hasUpdate: true,
    selfDeploy: true,
    runInProgress: false,
    now: IN_WINDOW,
    zone: "UTC",
    canary: READY,
  };

  it("applies an update in the window when nothing holds it", () => {
    expect(decideTick(base)).toEqual({ action: "apply" });
  });

  it("never applies under Off or Notify", () => {
    expect(decideTick({ ...base, policy: { ...base.policy, mode: "off" } }).action).toBe("none");
    expect(decideTick({ ...base, policy: { ...base.policy, mode: "notify" } }).action).toBe("none");
  });

  it("waits outside the window", () => {
    expect(decideTick({ ...base, now: OUT_OF_WINDOW })).toEqual({ action: "wait", reason: "Outside the maintenance window" });
  });

  it("waits on the canary", () => {
    const canary = { ready: false as const, reason: "Waiting for edge to run abc1234" };
    expect(decideTick({ ...base, canary })).toEqual({ action: "wait", reason: canary.reason });
  });

  it("does nothing when up to date, mid-run or on the legacy layout", () => {
    expect(decideTick({ ...base, hasUpdate: false }).action).toBe("none");
    expect(decideTick({ ...base, runInProgress: true }).action).toBe("none");
    expect(decideTick({ ...base, selfDeploy: false }).action).toBe("none");
  });
});

describe("verifyStep", () => {
  const start = Date.parse("2026-10-09T03:30:00Z");

  it("keeps checking until the window passes with enough healthy probes", () => {
    expect(verifyStep({ startedAt: start, now: start + 60_000, passes: 0, fails: 0, unhealthy: [] })).toEqual({ next: "verifying", passes: 1, fails: 0 });
    expect(verifyStep({ startedAt: start, now: start + VERIFY_WINDOW_MS, passes: 2, fails: 0, unhealthy: [] })).toEqual({ next: "verified" });
  });

  it("rolls back after three unhealthy probes in a row", () => {
    expect(verifyStep({ startedAt: start, now: start + 60_000, passes: 1, fails: 1, unhealthy: ["PostgreSQL"] })).toEqual({ next: "verifying", passes: 1, fails: 2 });
    expect(verifyStep({ startedAt: start, now: start + 120_000, passes: 1, fails: 2, unhealthy: ["PostgreSQL"] })).toEqual({
      next: "rollback",
      reason: "Unhealthy after the update: PostgreSQL",
    });
  });

  it("forgives a single blip", () => {
    expect(verifyStep({ startedAt: start, now: start + 60_000, passes: 1, fails: 2, unhealthy: [] })).toEqual({ next: "verifying", passes: 2, fails: 0 });
  });
});

describe("isRunActive", () => {
  const now = Date.parse("2026-10-09T03:30:00Z");
  it("is true for a run in flight and false once it ends or goes stale", () => {
    expect(isRunActive({ state: "verifying", startedAt: new Date(now - 60_000).toISOString() }, now)).toBe(true);
    expect(isRunActive({ state: "verified", startedAt: new Date(now - 60_000).toISOString() }, now)).toBe(false);
    expect(isRunActive({ state: "deploying", startedAt: new Date(now - 5 * 3_600_000).toISOString() }, now)).toBe(false);
    expect(isRunActive(null, now)).toBe(false);
  });
});
