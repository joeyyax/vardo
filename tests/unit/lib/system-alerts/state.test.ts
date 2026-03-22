import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldFire,
  markFired,
  getAlertState,
  clearAlertState,
} from "@/lib/system-alerts/state";

// Reset in-memory state between tests so tests are independent.
beforeEach(() => {
  clearAlertState();
});

// ---------------------------------------------------------------------------
// shouldFire / markFired — rate limiting
// ---------------------------------------------------------------------------

describe("shouldFire", () => {
  it("returns true for an alert type that has never fired", () => {
    expect(shouldFire("disk-space", "85")).toBe(true);
  });

  it("returns false immediately after markFired (within rate-limit window)", () => {
    markFired("disk-space", "85");
    expect(shouldFire("disk-space", "85")).toBe(false);
  });

  it("treats different keys for the same type independently", () => {
    markFired("disk-space", "85");
    // Threshold 90 has never fired — should fire
    expect(shouldFire("disk-space", "90")).toBe(true);
  });

  it("treats different alert types independently", () => {
    markFired("disk-space", "key");
    expect(shouldFire("service-degraded", "key")).toBe(true);
  });

  it("each alert type has a distinct rate-limit window (cert-expiring blocked after fire)", () => {
    expect(shouldFire("cert-expiring", "example.com")).toBe(true);
    markFired("cert-expiring", "example.com");
    expect(shouldFire("cert-expiring", "example.com")).toBe(false);
  });
});

describe("host-restarted — fires only once per process lifetime", () => {
  it("fires on first call", () => {
    expect(shouldFire("host-restarted", "restart")).toBe(true);
  });

  it("does not fire again after markFired (ignores time window)", () => {
    markFired("host-restarted", "restart");
    expect(shouldFire("host-restarted", "restart")).toBe(false);
  });

  it("clears the once-fired guard on clearAlertState", () => {
    markFired("host-restarted", "restart");
    expect(shouldFire("host-restarted", "restart")).toBe(false);

    clearAlertState();
    expect(shouldFire("host-restarted", "restart")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// markFired — records state
// ---------------------------------------------------------------------------

describe("markFired", () => {
  it("initialises count to 1 on first fire", () => {
    markFired("disk-space", "90");
    const state = getAlertState();
    const record = state.find((s) => s.type === "disk-space" && s.key === "90");
    expect(record?.count).toBe(1);
  });

  it("records lastFired as a recent Date", () => {
    const before = new Date();
    markFired("service-degraded", "redis");
    const after = new Date();

    const state = getAlertState();
    const record = state.find(
      (s) => s.type === "service-degraded" && s.key === "redis"
    );
    expect(record).toBeDefined();
    expect(record!.lastFired.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(record!.lastFired.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ---------------------------------------------------------------------------
// getAlertState
// ---------------------------------------------------------------------------

describe("getAlertState", () => {
  it("returns an empty array when no alerts have fired", () => {
    expect(getAlertState()).toEqual([]);
  });

  it("returns one entry per distinct type:key pair fired", () => {
    markFired("disk-space", "85");
    markFired("disk-space", "90");
    markFired("cert-expiring", "example.com");

    const state = getAlertState();
    expect(state).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// clearAlertState
// ---------------------------------------------------------------------------

describe("clearAlertState", () => {
  it("removes all fired alert records", () => {
    markFired("disk-space", "85");
    markFired("cert-expiring", "example.com");
    clearAlertState();
    expect(getAlertState()).toHaveLength(0);
  });

  it("allows alerts to fire again after clearing", () => {
    markFired("disk-space", "85");
    expect(shouldFire("disk-space", "85")).toBe(false);
    clearAlertState();
    expect(shouldFire("disk-space", "85")).toBe(true);
  });
});
