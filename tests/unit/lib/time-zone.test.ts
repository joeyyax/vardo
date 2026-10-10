import { describe, it, expect } from "vitest";
import {
  addZonedDays,
  formatClockRange,
  formatDayTime,
  isValidTimeZone,
  startOfZonedDay,
  zonedDateKey,
  zonedTimeToUtc,
} from "@/lib/time-zone";
import { nightlyRunKey } from "@/lib/backups/run-rules";
import { shouldRunNow } from "@/lib/cron/parse";
import { bucketStarts, digestWindow, isDigestDue, DEFAULT_DIGEST } from "@/lib/digest/window";
import { windowLabel } from "@/lib/digest/collector";

const LA = "America/Los_Angeles";
const BERLIN = "Europe/Berlin";

/** Every minute in [from, to) where `fires` is true. */
function firings(from: string, to: string, fires: (t: Date) => boolean): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from); t < Date.parse(to); t += 60_000) {
    if (fires(new Date(t))) out.push(new Date(t).toISOString());
  }
  return out;
}

describe("zonedTimeToUtc", () => {
  it("converts an ordinary wall time", () => {
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 2, minute: 0 }, LA).toISOString()).toBe(
      "2026-07-01T09:00:00.000Z",
    );
  });

  it("moves a time the spring jump skips to after the jump", () => {
    // 02:30 doesn't exist on 2026-03-08 in Los Angeles; it lands at 03:30 PDT.
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, LA).toISOString()).toBe(
      "2026-03-08T10:30:00.000Z",
    );
  });

  it("takes the first of a time the fall-back repeats", () => {
    // 01:30 happens at 08:30Z (PDT) and 09:30Z (PST) on 2026-11-01.
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, LA).toISOString()).toBe(
      "2026-11-01T08:30:00.000Z",
    );
  });

  it("cuts zoned days 23 and 25 hours long across DST", () => {
    const spring = startOfZonedDay(new Date("2026-03-08T12:00:00Z"), LA);
    expect(addZonedDays(spring, 1, LA).getTime() - spring.getTime()).toBe(23 * 3_600_000);
    const fall = startOfZonedDay(new Date("2026-11-01T12:00:00Z"), LA);
    expect(addZonedDays(fall, 1, LA).getTime() - fall.getTime()).toBe(25 * 3_600_000);
  });
});

describe("formatting", () => {
  it("prints UTC exactly as before", () => {
    expect(formatClockRange(new Date("2026-10-09T02:00:00Z"), new Date("2026-10-09T02:04:00Z"), "UTC")).toBe(
      "02:00–02:04 UTC",
    );
    expect(formatDayTime(new Date("2026-10-09T14:05:00Z"), "UTC")).toBe("Oct 9, 14:05 UTC");
  });

  it("prints local time with the zone's abbreviation", () => {
    expect(formatClockRange(new Date("2026-10-09T09:00:00Z"), new Date("2026-10-09T09:04:00Z"), LA)).toBe(
      "02:00–02:04 PDT",
    );
    expect(formatDayTime(new Date("2026-12-09T22:05:00Z"), LA)).toBe("Dec 9, 14:05 PST");
  });

  it("rejects unknown zones", () => {
    expect(isValidTimeZone(LA)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });
});

describe("nightlyRunKey", () => {
  it("reads the nightly time in the org's zone", () => {
    expect(nightlyRunKey("02:00", new Date("2026-07-01T09:00:20Z"), LA)).toBe("nightly:2026-07-01");
    expect(nightlyRunKey("02:00", new Date("2026-07-01T02:00:00Z"), LA)).toBeNull();
  });

  it("runs once on the spring-forward day when the time is skipped", () => {
    const keys = firings("2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z", (t) => nightlyRunKey("02:30", t, LA) !== null);
    expect(keys).toEqual(["2026-03-08T10:30:00.000Z"]);
  });

  it("runs once on the fall-back day when the time repeats", () => {
    const keys = firings("2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", (t) => nightlyRunKey("01:30", t, LA) !== null);
    expect(keys).toEqual(["2026-11-01T08:30:00.000Z"]);
  });

  it("keys the run by the zoned date", () => {
    // 23:30 in Los Angeles is the next day in UTC.
    expect(nightlyRunKey("23:30", new Date("2026-07-02T06:30:00Z"), LA)).toBe("nightly:2026-07-01");
  });
});

describe("shouldRunNow with a time zone", () => {
  it("matches UTC when asked", () => {
    expect(shouldRunNow("0 9 * * *", new Date("2026-10-09T09:00:30Z"), "UTC")).toBe(true);
    expect(shouldRunNow("0 9 * * *", new Date("2026-10-09T16:00:00Z"), "UTC")).toBe(false);
  });

  it("reads the schedule in the job's zone", () => {
    expect(shouldRunNow("0 9 * * *", new Date("2026-10-09T16:00:00Z"), LA)).toBe(true);
    expect(shouldRunNow("0 9 * * *", new Date("2026-10-09T09:00:00Z"), LA)).toBe(false);
  });

  it("runs a skipped daily time right after the spring jump", () => {
    expect(firings("2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z", (t) => shouldRunNow("30 2 * * *", t, LA))).toEqual([
      "2026-03-08T10:00:00.000Z",
    ]);
  });

  it("runs a repeated daily time once at the fall-back", () => {
    expect(firings("2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", (t) => shouldRunNow("30 1 * * *", t, LA))).toEqual([
      "2026-11-01T08:30:00.000Z",
    ]);
  });

  it("keeps an hourly job hourly through the fall-back", () => {
    expect(firings("2026-11-01T07:00:00Z", "2026-11-01T11:00:00Z", (t) => shouldRunNow("0 * * * *", t, LA))).toEqual([
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T09:00:00.000Z",
      "2026-11-01T10:00:00.000Z",
    ]);
  });

  it("handles a zone ahead of UTC", () => {
    // Berlin springs forward 2026-03-29 at 02:00 CET (01:00Z).
    expect(firings("2026-03-28T22:00:00Z", "2026-03-29T04:00:00Z", (t) => shouldRunNow("15 2 * * *", t, BERLIN))).toEqual([
      "2026-03-29T01:00:00.000Z",
    ]);
  });
});

describe("digest windows in a zone", () => {
  it("cuts the day at local midnight", () => {
    const w = digestWindow("daily", new Date("2026-10-12T15:00:00Z"), LA);
    expect(w.since.toISOString()).toBe("2026-10-11T07:00:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-12T07:00:00.000Z");
    expect(w.windowKey).toBe("daily:2026-10-11");
    expect(windowLabel(w)).toBe("Oct 11, 2026");
  });

  it("covers a 25-hour fall-back day with 25 hourly buckets", () => {
    const w = digestWindow("daily", new Date("2026-11-02T15:00:00Z"), LA);
    expect(w.until.getTime() - w.since.getTime()).toBe(25 * 3_600_000);
    expect(bucketStarts(w, 3_600_000)).toHaveLength(25);
  });

  it("keeps seven day buckets across a DST week", () => {
    const w = digestWindow("weekly", new Date("2026-11-02T16:00:00Z"), LA);
    expect(bucketStarts(w, 86_400_000)).toHaveLength(7);
    expect(zonedDateKey(w.since, LA)).toBe("2026-10-26");
    expect(windowLabel(w)).toBe("Oct 26 – Nov 1, 2026");
  });

  it("sends during the org's local hour", () => {
    // Default: Mondays at 08:00.
    expect(isDigestDue(DEFAULT_DIGEST, new Date("2026-10-12T15:10:00Z"), LA)).toBe(true);
    expect(isDigestDue(DEFAULT_DIGEST, new Date("2026-10-12T08:10:00Z"), LA)).toBe(false);
  });

  it("sends a digest whose hour the spring jump skips", () => {
    const daily = { ...DEFAULT_DIGEST, cadence: "daily" as const, hourOfDay: 2 };
    const due = firings("2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z", (t) => isDigestDue(daily, t, LA));
    expect(due[0]).toBe("2026-03-08T10:00:00.000Z");
  });
});
