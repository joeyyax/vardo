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
  it("measures the span rather than the execution clock", () => {
    // The deploy waited two minutes for a slot, then ran for 20s.
    const waited = deploy({
      startedAt: new Date("2026-08-03T10:00:00Z"),
      finishedAt: new Date("2026-08-03T10:02:20Z"),
      durationMs: 20_000,
    });
    expect(typicalElapsedMs([waited])).toBe(140_000);
  });

  it("takes the most recent success", () => {
    const rows = [
      deploy({ status: "failed", durationMs: 999 }),
      deploy({ finishedAt: new Date("2026-08-03T10:00:30Z") }),
      deploy({ finishedAt: new Date("2026-08-03T10:01:00Z") }),
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

  it("falls back to durationMs when the row has no finish time", () => {
    expect(typicalElapsedMs([deploy({ finishedAt: null })])).toBe(20_000);
  });

  it("falls back when a clock skew would make the span negative", () => {
    const skewed = deploy({
      startedAt: new Date("2026-08-03T10:00:20Z"),
      finishedAt: new Date("2026-08-03T10:00:00Z"),
    });
    expect(typicalElapsedMs([skewed])).toBe(20_000);
  });

  it("accepts serialized dates", () => {
    const serialized = {
      status: "success",
      durationMs: 20_000,
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
