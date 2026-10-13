import { describe, it, expect } from "vitest";
import { getNextRun } from "@/lib/backups/next-run";

describe("getNextRun", () => {
  it("returns null for a manual or unparseable schedule", () => {
    expect(getNextRun("manual")).toBeNull();
    expect(getNextRun("")).toBeNull();
    expect(getNextRun("not a cron")).toBeNull();
  });

  it("returns the next fire in the future at the scheduled hour", () => {
    const next = getNextRun("0 2 * * *", "UTC")!;
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getUTCHours()).toBe(2);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it("reads the schedule in the given zone", () => {
    const utc = getNextRun("0 2 * * *", "UTC")!;
    const tokyo = getNextRun("0 2 * * *", "Asia/Tokyo")!;
    expect(tokyo.getUTCHours()).toBe(17);
    expect(tokyo.getTime()).not.toBe(utc.getTime());
  });
});
