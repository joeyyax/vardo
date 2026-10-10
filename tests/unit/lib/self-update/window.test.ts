import { describe, it, expect } from "vitest";
import { inWindow, isValidTimeZone, localMinutes, nextWindowOpen, parseClock, windowZone } from "@/lib/self-update/window";

describe("parseClock", () => {
  it("reads HH:MM and rejects anything else", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("23:59")).toBe(23 * 60 + 59);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("3:00")).toBeNull();
  });
});

describe("inWindow", () => {
  const night = { start: "03:00", end: "05:00" };

  it("includes the start and excludes the end", () => {
    expect(inWindow(new Date("2026-10-09T03:00:00Z"), night, "UTC")).toBe(true);
    expect(inWindow(new Date("2026-10-09T04:59:00Z"), night, "UTC")).toBe(true);
    expect(inWindow(new Date("2026-10-09T05:00:00Z"), night, "UTC")).toBe(false);
    expect(inWindow(new Date("2026-10-09T02:59:00Z"), night, "UTC")).toBe(false);
  });

  it("runs past midnight when the end comes first", () => {
    const late = { start: "23:00", end: "02:00" };
    expect(inWindow(new Date("2026-10-09T23:30:00Z"), late, "UTC")).toBe(true);
    expect(inWindow(new Date("2026-10-10T01:59:00Z"), late, "UTC")).toBe(true);
    expect(inWindow(new Date("2026-10-10T02:00:00Z"), late, "UTC")).toBe(false);
    expect(inWindow(new Date("2026-10-09T12:00:00Z"), late, "UTC")).toBe(false);
  });

  it("reads the clock in the window's zone", () => {
    // 10:30 UTC is 03:30 in Los Angeles (PDT).
    expect(inWindow(new Date("2026-10-09T10:30:00Z"), night, "America/Los_Angeles")).toBe(true);
    expect(inWindow(new Date("2026-10-09T03:30:00Z"), night, "America/Los_Angeles")).toBe(false);
  });

  it("follows daylight saving time", () => {
    // 03:30 local is 10:30 UTC in October (PDT) and 11:30 UTC in December (PST).
    expect(inWindow(new Date("2026-12-09T11:30:00Z"), night, "America/Los_Angeles")).toBe(true);
    expect(inWindow(new Date("2026-12-09T10:30:00Z"), night, "America/Los_Angeles")).toBe(false);
  });

  it("is open all day when start equals end", () => {
    expect(inWindow(new Date("2026-10-09T15:00:00Z"), { start: "04:00", end: "04:00" }, "UTC")).toBe(true);
  });
});

describe("nextWindowOpen", () => {
  it("is the next start, or null while open", () => {
    const night = { start: "03:00", end: "05:00" };
    expect(nextWindowOpen(new Date("2026-10-09T12:00:00Z"), night, "UTC")?.toISOString()).toBe("2026-10-10T03:00:00.000Z");
    expect(nextWindowOpen(new Date("2026-10-09T03:10:00Z"), night, "UTC")).toBeNull();
  });
});

describe("windowZone", () => {
  it("takes the window's zone, then the instance's, then UTC", () => {
    expect(windowZone("Europe/Berlin", "America/New_York")).toBe("Europe/Berlin");
    expect(windowZone(null, "America/New_York")).toBe("America/New_York");
    expect(windowZone(null, null)).toBe("UTC");
    expect(windowZone("Not/AZone", null)).toBe("UTC");
  });

  it("validates zones and reads local minutes", () => {
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("")).toBe(false);
    expect(localMinutes(new Date("2026-10-09T00:15:00Z"), "Asia/Tokyo")).toBe(9 * 60 + 15);
  });
});
