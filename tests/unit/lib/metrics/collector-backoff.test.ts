import { describe, it, expect } from "vitest";
import { nextInterval } from "@/lib/metrics/collector";

describe("nextInterval", () => {
  it("polls fast during warmup", () => {
    expect(nextInterval({ tickCount: 0, consecutiveFailures: 0 })).toBe(5000);
  });

  it("settles to 30s after warmup", () => {
    expect(nextInterval({ tickCount: 25, consecutiveFailures: 0 })).toBe(30000);
  });

  it("doubles the interval per consecutive failure", () => {
    expect(nextInterval({ tickCount: 25, consecutiveFailures: 1 })).toBe(30000);
    expect(nextInterval({ tickCount: 25, consecutiveFailures: 2 })).toBe(60000);
    expect(nextInterval({ tickCount: 25, consecutiveFailures: 3 })).toBe(120000);
  });

  it("caps the backoff at 15 minutes", () => {
    expect(nextInterval({ tickCount: 25, consecutiveFailures: 19 })).toBe(15 * 60_000);
  });

  it("backs off during warmup too", () => {
    expect(nextInterval({ tickCount: 1, consecutiveFailures: 2 })).toBe(60000);
  });
});
