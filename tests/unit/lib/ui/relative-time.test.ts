process.env.TZ = "UTC";

import { describe, it, expect } from "vitest";

import { formatAbsoluteDateTime, formatRelativeTime, toDate } from "@/lib/ui/relative-time";

const now = new Date("2026-07-31T12:00:00.000Z");

describe("formatRelativeTime", () => {
  it("returns an em dash for a missing date", () => {
    expect(formatRelativeTime(null)).toBe("—");
    expect(formatRelativeTime(undefined)).toBe("—");
  });

  it("returns an em dash for an invalid date", () => {
    expect(formatRelativeTime("not-a-date")).toBe("—");
  });

  it("collapses very recent times to 'just now'", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 5_000), now)).toBe("just now");
  });

  it("formats seconds", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 45_000), now)).toBe("45s ago");
  });

  it("formats minutes", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 60_000), now)).toBe("3m ago");
  });

  it("formats hours", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 6 * 3_600_000), now)).toBe("6h ago");
  });

  it("formats days", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 4 * 86_400_000), now)).toBe("4d ago");
  });

  it("formats months", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 90 * 86_400_000), now)).toBe("3mo ago");
  });

  it("formats years", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 400 * 86_400_000), now)).toBe("1y ago");
  });

  it("formats future dates with an 'in' prefix", () => {
    expect(formatRelativeTime(new Date(now.getTime() + 3 * 60_000), now)).toBe("in 3m");
  });

  it("accepts string and number inputs", () => {
    expect(formatRelativeTime(now.toISOString(), now)).toBe("just now");
    expect(formatRelativeTime(now.getTime(), now)).toBe("just now");
  });
});

describe("formatAbsoluteDateTime", () => {
  it("returns an em dash for a missing or invalid date", () => {
    expect(formatAbsoluteDateTime(null)).toBe("—");
    expect(formatAbsoluteDateTime("nope")).toBe("—");
  });

  it("formats an exact date and time", () => {
    expect(formatAbsoluteDateTime(new Date("2026-03-30T15:45:00.000Z"))).toBe(
      "Mar 30, 2026, 3:45 PM",
    );
  });
});

describe("toDate", () => {
  it("parses valid input and rejects invalid or missing input", () => {
    expect(toDate("2026-01-01T00:00:00.000Z")).toBeInstanceOf(Date);
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("garbage")).toBeNull();
  });
});
