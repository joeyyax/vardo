process.env.TZ = "UTC";

import { describe, it, expect } from "vitest";

import { readFileSync, readdirSync } from "fs";
import path from "path";

import { formatAbsoluteDateTime, formatRelativeTime, formatSpan, toDate } from "@/lib/ui/relative-time";

const now = new Date("2026-07-31T12:00:00.000Z");

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;
const MONTH = YEAR / 12;

const ago = (elapsedMs: number) => formatRelativeTime(new Date(now.getTime() - elapsedMs), now);

describe("formatRelativeTime", () => {
  it("returns an em dash for a missing date", () => {
    expect(formatRelativeTime(null)).toBe("—");
    expect(formatRelativeTime(undefined)).toBe("—");
  });

  it("returns an em dash for an invalid date", () => {
    expect(formatRelativeTime("not-a-date")).toBe("—");
  });

  describe.each([
    ["opens 'just now'", 0, "just now"],
    ["holds 'just now' to the last sub-10s tick", 9 * SECOND, "just now"],
    ["opens seconds at 10s", 10 * SECOND, "10s ago"],
    ["mid-band seconds", 45 * SECOND, "45s ago"],
    ["closes seconds at 59s", 59 * SECOND, "59s ago"],
    ["opens minutes at 1m", MINUTE, "1m ago"],
    ["mid-band minutes", 3 * MINUTE, "3m ago"],
    ["closes minutes at 59m59s", HOUR - SECOND, "59m ago"],
    ["opens hours at 1h", HOUR, "1h ago"],
    ["mid-band hours", 6 * HOUR, "6h ago"],
    ["closes hours at 23h59m59s", DAY - SECOND, "23h ago"],
    ["opens days at 1d", DAY, "1d ago"],
    ["mid-band days", 4 * DAY, "4d ago"],
    ["closes days one second short of 2w", 2 * WEEK - SECOND, "13d ago"],
    ["opens weeks at 2w", 2 * WEEK, "2w ago"],
    ["mid-band weeks", 20 * DAY, "2w ago"],
    ["reads 47d22h as weeks, not a month", 47 * DAY + 22 * HOUR, "6w ago"],
    ["closes weeks one second short of 2mo", 2 * MONTH - SECOND, "8w ago"],
    ["opens months at 2mo", 2 * MONTH, "2mo ago"],
    ["mid-band months", 90 * DAY, "2mo ago"],
    ["closes months one second short of a year", YEAR - SECOND, "11mo ago"],
    ["opens years at 1y", YEAR, "1y ago"],
    ["mid-band years", 400 * DAY, "1y ago"],
    ["counts further years", 2 * YEAR, "2y ago"],
  ])("%s", (_label, elapsed, expected) => {
    it(`reads "${expected}"`, () => {
      expect(ago(elapsed)).toBe(expected);
    });
  });

  it("never jumps backwards across a unit change", () => {
    const boundaries = [10 * SECOND, MINUTE, HOUR, DAY, 2 * WEEK, 2 * MONTH, YEAR];
    for (const boundary of boundaries) {
      expect(ago(boundary - SECOND)).not.toBe(ago(boundary));
    }
  });

  it("formats future dates with an 'in' prefix", () => {
    expect(formatRelativeTime(new Date(now.getTime() + 3 * MINUTE), now)).toBe("in 3m");
    expect(formatRelativeTime(new Date(now.getTime() + 47 * DAY), now)).toBe("in 6w");
  });

  it("accepts string and number inputs", () => {
    expect(formatRelativeTime(now.toISOString(), now)).toBe("just now");
    expect(formatRelativeTime(now.getTime(), now)).toBe("just now");
  });
});

describe("formatSpan", () => {
  it("returns an em dash for a missing or invalid date", () => {
    expect(formatSpan(null)).toBe("—");
    expect(formatSpan("nope")).toBe("—");
  });

  it("carries the weeks bucket", () => {
    expect(formatSpan(new Date(now.getTime() - 47 * DAY), now)).toBe("6w");
  });

  it("names a span under ten seconds rather than saying 'just now'", () => {
    expect(formatSpan(new Date(now.getTime() - 3 * SECOND), now)).toBe("3s");
  });

  // The weeks bucket once landed in one formatter and not the other, so the same
  // timestamp read "7w ago" on a card and "2 months" a hover away.
  it("agrees with formatRelativeTime on every bucket, in both directions", () => {
    for (let seconds = 10; seconds < 3 * YEAR / SECOND; seconds = Math.ceil(seconds * 1.01)) {
      const elapsed = seconds * SECOND;
      const span = formatSpan(new Date(now.getTime() - elapsed), now);
      expect(formatRelativeTime(new Date(now.getTime() - elapsed), now)).toBe(`${span} ago`);
      expect(formatRelativeTime(new Date(now.getTime() + elapsed), now)).toBe(`in ${span}`);
    }
  });
});

describe("relative time formatting has one home", () => {
  const ROOT = path.resolve(__dirname, "../../../..");
  const DIRS = ["app", "components", "lib", "hooks"];

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("has no date-fns relative formatter left in the UI", () => {
    const files = DIRS.flatMap((dir) => sources(path.join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((file) => /from "date-fns"/.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
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
