import { describe, it, expect } from "vitest";

import {
  clampGracePeriod,
  evaluateWatch,
  otherSlot,
  DEFAULT_GRACE_PERIOD_SECONDS,
  MAX_GRACE_PERIOD_SECONDS,
  type WatchCandidate,
} from "@/lib/deploy/rollback-watch";

const NOW = 1_700_000_000_000;

function candidate(overrides: Partial<WatchCandidate> = {}): WatchCandidate {
  return {
    appName: "my-app",
    appStatus: "active",
    slot: "green",
    finishedAt: new Date(NOW - 10_000),
    gracePeriodSeconds: 60,
    superseded: false,
    ...overrides,
  };
}

describe("otherSlot", () => {
  it("pairs blue and green", () => {
    expect(otherSlot("blue")).toBe("green");
    expect(otherSlot("green")).toBe("blue");
  });
});

describe("clampGracePeriod", () => {
  it("falls back to the default when unset", () => {
    expect(clampGracePeriod(null)).toBe(DEFAULT_GRACE_PERIOD_SECONDS);
  });

  it("bounds the value to the range the API accepts", () => {
    expect(clampGracePeriod(0)).toBe(1);
    expect(clampGracePeriod(-30)).toBe(1);
    expect(clampGracePeriod(10_000)).toBe(MAX_GRACE_PERIOD_SECONDS);
    expect(clampGracePeriod(120)).toBe(120);
  });
});

describe("evaluateWatch", () => {
  it("watches a fresh successful blue-green deploy", () => {
    const verdict = evaluateWatch(candidate(), NOW);
    expect(verdict).toEqual({ watch: true, slot: "green", standbySlot: "blue" });
  });

  it("never arms for Vardo deploying itself", () => {
    const verdict = evaluateWatch(candidate({ appName: "vardo" }), NOW);
    expect(verdict).toEqual({ watch: false, reason: "self-deploy" });
  });

  it("still watches after the grace period has partly elapsed", () => {
    // The window is derived from the row, so a process that started 50s into a
    // 60s grace period picks the watch back up.
    const verdict = evaluateWatch(
      candidate({ finishedAt: new Date(NOW - 50_000) }),
      NOW,
    );
    expect(verdict).toMatchObject({ watch: true });
  });

  it("stops watching once the grace period has elapsed", () => {
    const verdict = evaluateWatch(
      candidate({ finishedAt: new Date(NOW - 61_000) }),
      NOW,
    );
    expect(verdict).toEqual({ watch: false, reason: "grace period elapsed" });
  });

  it("skips a deploy that a later one has superseded", () => {
    const verdict = evaluateWatch(candidate({ superseded: true }), NOW);
    expect(verdict).toEqual({ watch: false, reason: "superseded by a later deploy" });
  });

  it("skips an app that is no longer active", () => {
    expect(evaluateWatch(candidate({ appStatus: "stopped" }), NOW)).toEqual({
      watch: false,
      reason: "app is stopped",
    });
    expect(evaluateWatch(candidate({ appStatus: "deploying" }), NOW)).toEqual({
      watch: false,
      reason: "app is deploying",
    });
  });

  it("skips local and slotless deploys", () => {
    expect(evaluateWatch(candidate({ slot: "local" }), NOW)).toMatchObject({ watch: false });
    expect(evaluateWatch(candidate({ slot: null }), NOW)).toMatchObject({ watch: false });
  });

  it("skips a deployment with no finish time", () => {
    expect(evaluateWatch(candidate({ finishedAt: null }), NOW)).toEqual({
      watch: false,
      reason: "no finish time",
    });
  });

  it("uses the default grace period when the app has none", () => {
    const withinDefault = candidate({
      gracePeriodSeconds: null,
      finishedAt: new Date(NOW - (DEFAULT_GRACE_PERIOD_SECONDS - 5) * 1000),
    });
    expect(evaluateWatch(withinDefault, NOW)).toMatchObject({ watch: true });

    const pastDefault = candidate({
      gracePeriodSeconds: null,
      finishedAt: new Date(NOW - (DEFAULT_GRACE_PERIOD_SECONDS + 5) * 1000),
    });
    expect(evaluateWatch(pastDefault, NOW)).toMatchObject({ watch: false });
  });
});
