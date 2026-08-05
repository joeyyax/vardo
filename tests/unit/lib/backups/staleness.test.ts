import { describe, it, expect } from "vitest";
import {
  OVERDUE_INTERVALS,
  overdueBackupJobs,
  scheduleIntervalMs,
  type ScheduledBackupJob,
} from "@/lib/backups/staleness";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-03-10T09:00:00Z");

function job(overrides: Partial<ScheduledBackupJob> = {}): ScheduledBackupJob {
  return {
    id: "job-1",
    name: "Auto: agents",
    schedule: "17 3 * * *",
    enabled: true,
    lastRunAt: new Date(NOW.getTime() - DAY),
    createdAt: new Date(NOW.getTime() - 30 * DAY),
    ...overrides,
  };
}

describe("scheduleIntervalMs", () => {
  it("measures a daily schedule as a day", () => {
    expect(scheduleIntervalMs("17 3 * * *", NOW)).toBe(DAY);
  });

  it("measures an hourly schedule as an hour", () => {
    expect(scheduleIntervalMs("0 * * * *", NOW)).toBe(HOUR);
  });

  it("takes the longest gap, so a weekday job is not overdue every Monday", () => {
    expect(scheduleIntervalMs("0 2 * * 1-5", NOW)).toBe(3 * DAY);
  });

  it("returns null for an expression it cannot read", () => {
    expect(scheduleIntervalMs("not a cron", NOW)).toBeNull();
    expect(scheduleIntervalMs("   ", NOW)).toBeNull();
  });
});

describe("overdueBackupJobs", () => {
  it("leaves a job alone while it is capturing on schedule", () => {
    expect(overdueBackupJobs([job()], NOW)).toEqual([]);
  });

  it("allows one missed run before calling a job overdue", () => {
    const barely = job({ lastRunAt: new Date(NOW.getTime() - OVERDUE_INTERVALS * DAY) });
    expect(overdueBackupJobs([barely], NOW)).toEqual([]);
  });

  it("reports a job that has captured nothing for more than two intervals", () => {
    const stale = job({ lastRunAt: new Date(NOW.getTime() - 5 * DAY) });
    const [entry] = overdueBackupJobs([stale], NOW);
    expect(entry.job.id).toBe("job-1");
    expect(entry.neverRan).toBe(false);
    expect(entry.since).toEqual(stale.lastRunAt);
  });

  // The whole point of measuring against the schedule: an hourly job that has
  // been quiet since yesterday should not have to wait for a fixed 48h window.
  it("measures each job against its own schedule", () => {
    const hourly = job({ schedule: "0 * * * *", lastRunAt: new Date(NOW.getTime() - 3 * HOUR) });
    expect(overdueBackupJobs([hourly], NOW)).toHaveLength(1);
  });

  it("dates a job that has never run from when it was created", () => {
    const fresh = job({ lastRunAt: null, createdAt: new Date(NOW.getTime() - HOUR) });
    expect(overdueBackupJobs([fresh], NOW)).toEqual([]);

    const forgotten = job({ lastRunAt: null, createdAt: new Date(NOW.getTime() - 5 * DAY) });
    const [entry] = overdueBackupJobs([forgotten], NOW);
    expect(entry.neverRan).toBe(true);
    expect(entry.since).toEqual(forgotten.createdAt);
  });

  it("says nothing about a job that is turned off", () => {
    const off = job({ enabled: false, lastRunAt: new Date(NOW.getTime() - 30 * DAY) });
    expect(overdueBackupJobs([off], NOW)).toEqual([]);
  });

  it("says nothing about a schedule it cannot read", () => {
    const broken = job({ schedule: "every other tuesday", lastRunAt: null });
    expect(overdueBackupJobs([broken], NOW)).toEqual([]);
  });
});
