import { describe, it, expect } from "vitest";
import {
  shouldRunNow,
  matchesCronField,
  isSameMinute,
} from "@/lib/cron/parse";

describe("matchesCronField", () => {
  it("matches wildcard", () => {
    expect(matchesCronField(0, "*")).toBe(true);
    expect(matchesCronField(59, "*")).toBe(true);
  });

  it("matches exact value", () => {
    expect(matchesCronField(5, "5")).toBe(true);
    expect(matchesCronField(5, "6")).toBe(false);
  });

  it("matches step values (*/N)", () => {
    expect(matchesCronField(0, "*/5")).toBe(true);
    expect(matchesCronField(15, "*/5")).toBe(true);
    expect(matchesCronField(3, "*/5")).toBe(false);
  });

  it("matches ranges (N-M)", () => {
    expect(matchesCronField(3, "1-5")).toBe(true);
    expect(matchesCronField(1, "1-5")).toBe(true);
    expect(matchesCronField(5, "1-5")).toBe(true);
    expect(matchesCronField(6, "1-5")).toBe(false);
  });

  it("matches comma-separated values", () => {
    expect(matchesCronField(1, "1,3,5")).toBe(true);
    expect(matchesCronField(3, "1,3,5")).toBe(true);
    expect(matchesCronField(2, "1,3,5")).toBe(false);
  });

  it("matches mixed comma and range", () => {
    expect(matchesCronField(2, "1-3,7,10-12")).toBe(true);
    expect(matchesCronField(7, "1-3,7,10-12")).toBe(true);
    expect(matchesCronField(11, "1-3,7,10-12")).toBe(true);
    expect(matchesCronField(5, "1-3,7,10-12")).toBe(false);
  });
});

describe("shouldRunNow", () => {
  it("matches every-minute schedule", () => {
    const now = new Date(2026, 2, 21, 10, 30, 0); // March 21, 2026, 10:30
    expect(shouldRunNow("* * * * *", now)).toBe(true);
  });

  it("matches specific minute and hour", () => {
    const now = new Date(2026, 2, 21, 14, 30, 0);
    expect(shouldRunNow("30 14 * * *", now)).toBe(true);
    expect(shouldRunNow("31 14 * * *", now)).toBe(false);
  });

  it("matches day of week (Saturday = 6)", () => {
    const sat = new Date(2026, 2, 21, 0, 0, 0); // March 21, 2026 is Saturday
    expect(shouldRunNow("0 0 * * 6", sat)).toBe(true);
    expect(shouldRunNow("0 0 * * 0", sat)).toBe(false);
  });

  it("rejects invalid expressions", () => {
    const now = new Date();
    expect(shouldRunNow("* * *", now)).toBe(false);
    expect(shouldRunNow("", now)).toBe(false);
  });

  it("matches step minutes", () => {
    const now = new Date(2026, 2, 21, 10, 15, 0);
    expect(shouldRunNow("*/15 * * * *", now)).toBe(true);
    expect(shouldRunNow("*/10 * * * *", now)).toBe(false);
  });
});

describe("isSameMinute", () => {
  it("returns true for same minute", () => {
    const a = new Date(2026, 2, 21, 10, 30, 0);
    const b = new Date(2026, 2, 21, 10, 30, 45);
    expect(isSameMinute(a, b)).toBe(true);
  });

  it("returns false for different minutes", () => {
    const a = new Date(2026, 2, 21, 10, 30, 0);
    const b = new Date(2026, 2, 21, 10, 31, 0);
    expect(isSameMinute(a, b)).toBe(false);
  });
});
