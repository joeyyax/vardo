import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, effectiveChannel, parsePolicy, updatePolicySchema } from "@/lib/self-update/policy";
import { isRunActive, verifyStep, VERIFY_WINDOW_MS } from "@/lib/self-update/decide";

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

  it("replaces unreadable fields with defaults and ignores old scheduling fields", () => {
    const p = parsePolicy({
      mode: "sometimes",
      channel: "nightly",
      priority: "urgent",
      window: { start: "25:00", end: "04:00", timezone: "Mars/Olympus" },
      canary: { role: "follower", canaryInstanceId: "", soakHours: 9999 },
    });
    expect(p).toEqual({ ...DEFAULT_POLICY, channel: "main" });
  });

  it("validates input from the API", () => {
    const ok = { ...DEFAULT_POLICY, mode: "auto", priority: "critical" };
    expect(updatePolicySchema.safeParse(ok).success).toBe(true);
    expect(updatePolicySchema.safeParse({ ...ok, priority: "urgent" }).success).toBe(false);
    expect(updatePolicySchema.safeParse({ ...ok, channel: "nightly" }).success).toBe(false);
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
