import { describe, it, expect } from "vitest";
import { typicalElapsedMs, type TimedDeployment } from "@/lib/ui/deploy-timing";

function deploy(over: Partial<TimedDeployment> = {}): TimedDeployment {
  return {
    status: "success",
    durationMs: 20_000,
    startedAt: new Date("2026-08-03T10:00:00Z"),
    finishedAt: new Date("2026-08-03T10:00:20Z"),
    ...over,
  };
}

describe("typicalElapsedMs", () => {
  it("measures run time rather than the span, which includes queue wait", () => {
    // The deploy waited two minutes for a slot, then ran for 20s.
    const waited = deploy({
      startedAt: new Date("2026-08-03T10:00:00Z"),
      finishedAt: new Date("2026-08-03T10:02:20Z"),
      durationMs: 20_000,
    });
    expect(typicalElapsedMs([waited])).toBe(20_000);
  });

  it("takes the most recent success", () => {
    const rows = [
      deploy({ status: "failed", durationMs: 999 }),
      deploy({ durationMs: 30_000 }),
      deploy({ durationMs: 60_000 }),
    ];
    expect(typicalElapsedMs(rows)).toBe(30_000);
  });

  it("skips rows that are not successful", () => {
    const rows = [
      deploy({ status: "cancelled" }),
      deploy({ status: "rolled_back" }),
      deploy({ status: "superseded" }),
    ];
    expect(typicalElapsedMs(rows)).toBeNull();
  });

  it("falls back to the span when the row has no run time", () => {
    expect(typicalElapsedMs([deploy({ durationMs: null })])).toBe(20_000);
    expect(typicalElapsedMs([deploy({ durationMs: 0 })])).toBe(20_000);
  });

  it("skips a row whose clock skew makes the span negative", () => {
    const skewed = deploy({
      durationMs: null,
      startedAt: new Date("2026-08-03T10:00:20Z"),
      finishedAt: new Date("2026-08-03T10:00:00Z"),
    });
    expect(typicalElapsedMs([skewed, deploy({ durationMs: 7_000 })])).toBe(7_000);
  });

  it("accepts serialized dates", () => {
    const serialized = {
      status: "success",
      durationMs: null,
      startedAt: "2026-08-03T10:00:00Z",
      finishedAt: "2026-08-03T10:00:45Z",
    };
    expect(typicalElapsedMs([serialized])).toBe(45_000);
  });

  it("returns null with nothing to measure", () => {
    expect(typicalElapsedMs([])).toBeNull();
    expect(typicalElapsedMs([deploy({ finishedAt: null, durationMs: null })])).toBeNull();
  });
});
