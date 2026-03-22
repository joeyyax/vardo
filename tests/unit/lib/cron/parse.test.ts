import { describe, it, expect } from "vitest";
import { shouldRunNow, isSameMinute } from "@/lib/cron/parse";

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

  it("matches step minutes (*/N)", () => {
    const now = new Date(2026, 2, 21, 10, 15, 0);
    expect(shouldRunNow("*/15 * * * *", now)).toBe(true);
    expect(shouldRunNow("*/10 * * * *", now)).toBe(false);
  });

  it("matches comma-separated values", () => {
    const at1 = new Date(2026, 2, 21, 10, 1, 0);
    const at3 = new Date(2026, 2, 21, 10, 3, 0);
    const at2 = new Date(2026, 2, 21, 10, 2, 0);
    expect(shouldRunNow("1,3,5 * * * *", at1)).toBe(true);
    expect(shouldRunNow("1,3,5 * * * *", at3)).toBe(true);
    expect(shouldRunNow("1,3,5 * * * *", at2)).toBe(false);
  });

  it("matches ranges (N-M)", () => {
    const at3 = new Date(2026, 2, 21, 10, 3, 0);
    const at6 = new Date(2026, 2, 21, 10, 6, 0);
    expect(shouldRunNow("1-5 * * * *", at3)).toBe(true);
    expect(shouldRunNow("1-5 * * * *", at6)).toBe(false);
  });

  it("matches named shorthands", () => {
    const midnight = new Date(2026, 2, 21, 0, 0, 0);
    const noon = new Date(2026, 2, 21, 12, 0, 0);
    expect(shouldRunNow("@daily", midnight)).toBe(true);
    expect(shouldRunNow("@daily", noon)).toBe(false);
    expect(shouldRunNow("@midnight", midnight)).toBe(true);
    const topOfHour = new Date(2026, 2, 21, 10, 0, 0);
    const midHour = new Date(2026, 2, 21, 10, 30, 0);
    expect(shouldRunNow("@hourly", topOfHour)).toBe(true);
    expect(shouldRunNow("@hourly", midHour)).toBe(false);
  });

  it("matches step ranges (N-M/N)", () => {
    const at1 = new Date(2026, 2, 21, 10, 1, 0);
    const at3 = new Date(2026, 2, 21, 10, 3, 0);
    const at2 = new Date(2026, 2, 21, 10, 2, 0);
    expect(shouldRunNow("1-5/2 * * * *", at1)).toBe(true);
    expect(shouldRunNow("1-5/2 * * * *", at3)).toBe(true);
    expect(shouldRunNow("1-5/2 * * * *", at2)).toBe(false);
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
