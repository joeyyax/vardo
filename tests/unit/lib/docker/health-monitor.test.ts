import { describe, it, expect, afterEach } from "vitest";
import {
  decideRestart,
  effectiveAutoRestart,
  isCrashLooping,
  getCrashLoopThreshold,
  CONFIRM_STREAK,
  RESTART_BACKOFF_MS,
  RESTART_WINDOW_MS,
  MAX_RESTARTS_PER_WINDOW,
} from "@/lib/docker/health-monitor";

const NOW = 1_000_000_000;

describe("decideRestart", () => {
  it("waits until the unhealthy streak is confirmed", () => {
    expect(decideRestart({ streak: CONFIRM_STREAK - 1, recentRestarts: [], now: NOW })).toBe("wait");
  });

  it("restarts once the streak is confirmed and there is no recent restart", () => {
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: [], now: NOW })).toBe("restart");
  });

  it("backs off when a restart happened within the backoff window", () => {
    const recent = NOW - (RESTART_BACKOFF_MS - 1);
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: [recent], now: NOW })).toBe(
      "backoff",
    );
  });

  it("restarts again once the backoff window has elapsed", () => {
    const recent = NOW - (RESTART_BACKOFF_MS + 1);
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: [recent], now: NOW })).toBe(
      "restart",
    );
  });

  it("gives up after the max restarts in the window", () => {
    // Spread the timestamps so none is inside the backoff window — the cap, not
    // backoff, must be what stops us.
    const restarts = Array.from(
      { length: MAX_RESTARTS_PER_WINDOW },
      (_, i) => NOW - RESTART_WINDOW_MS + i * (RESTART_BACKOFF_MS + 1),
    );
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: restarts, now: NOW })).toBe(
      "giveup",
    );
  });
});

describe("effectiveAutoRestart", () => {
  it("defaults ON for critical apps when the field is unset", () => {
    expect(effectiveAutoRestart({ autoRestartUnhealthy: null, priority: "critical" })).toBe(true);
  });

  it("defaults OFF for non-critical apps when the field is unset", () => {
    expect(effectiveAutoRestart({ autoRestartUnhealthy: null, priority: "standard" })).toBe(false);
    expect(effectiveAutoRestart({ autoRestartUnhealthy: null, priority: "disposable" })).toBe(false);
  });

  it("explicit setting overrides the priority default", () => {
    expect(effectiveAutoRestart({ autoRestartUnhealthy: false, priority: "critical" })).toBe(false);
    expect(effectiveAutoRestart({ autoRestartUnhealthy: true, priority: "standard" })).toBe(true);
  });
});

describe("isCrashLooping", () => {
  it("fires once restarts pass the threshold without ever reaching healthy", () => {
    expect(isCrashLooping({ restartsSinceBaseline: 5, everHealthy: false, threshold: 5 })).toBe(true);
  });

  it("stays quiet below the threshold", () => {
    expect(isCrashLooping({ restartsSinceBaseline: 4, everHealthy: false, threshold: 5 })).toBe(false);
  });

  it("never fires for a container that has been healthy", () => {
    expect(isCrashLooping({ restartsSinceBaseline: 50, everHealthy: true, threshold: 5 })).toBe(false);
  });
});

describe("getCrashLoopThreshold", () => {
  const original = process.env.VARDO_CRASH_LOOP_RESTARTS;
  afterEach(() => {
    if (original === undefined) delete process.env.VARDO_CRASH_LOOP_RESTARTS;
    else process.env.VARDO_CRASH_LOOP_RESTARTS = original;
  });

  it("defaults to 5", () => {
    delete process.env.VARDO_CRASH_LOOP_RESTARTS;
    expect(getCrashLoopThreshold()).toBe(5);
  });

  it("reads the env override", () => {
    process.env.VARDO_CRASH_LOOP_RESTARTS = "12";
    expect(getCrashLoopThreshold()).toBe(12);
  });

  it("floors at 2 so a single restart can never trip it", () => {
    process.env.VARDO_CRASH_LOOP_RESTARTS = "1";
    expect(getCrashLoopThreshold()).toBe(2);
  });
});
