import { describe, it, expect } from "vitest";
import {
  OVERDUE_INTERVALS,
  backupJobStaleness,
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

describe("backupJobStaleness", () => {
  const ran = new Date(NOW.getTime() - 90 * DAY);
  const stale = new Date(NOW.getTime() - 60 * DAY);
  const parked = { id: "nvr", status: "stopped", parked: true, lastRunningAt: ran };
  const running = { id: "web", status: "active", parked: false, lastRunningAt: NOW };
  const crashed = { id: "db", status: "error", parked: false, lastRunningAt: ran };
  const vanished = { id: "gone", status: "missing", parked: false, lastRunningAt: ran };

  it("reads a job whose apps were all stopped on purpose as stopped, with its last backup", () => {
    const { overdue, stopped } = backupJobStaleness([job({ lastRunAt: stale, apps: [parked] })], NOW);
    expect(overdue).toEqual([]);
    expect(stopped).toEqual([expect.objectContaining({ lastBackupAt: stale })]);
    expect(overdueBackupJobs([job({ lastRunAt: stale, apps: [parked] })], NOW)).toEqual([]);
  });

  it("counts a crashed app and one that vanished after running as overdue", () => {
    for (const app of [crashed, vanished]) {
      const { overdue, stopped } = backupJobStaleness([job({ lastRunAt: stale, apps: [app] })], NOW);
      expect(stopped).toEqual([]);
      expect(overdue).toHaveLength(1);
    }
  });

  it("keeps a mixed job overdue and names the stopped apps to leave out", () => {
    const [entry] = overdueBackupJobs([job({ lastRunAt: stale, apps: [parked, running] })], NOW);
    expect(entry.stoppedAppIds).toEqual(["nvr"]);
  });

  it("keeps a job overdue when it also covers a volume no app owns", () => {
    expect(overdueBackupJobs([job({ lastRunAt: stale, apps: [parked], looseVolumes: true })], NOW)).toHaveLength(1);
  });

  it("says nothing about a stopped app's job that is still on schedule", () => {
    expect(backupJobStaleness([job({ apps: [parked] })], NOW)).toEqual({ overdue: [], stopped: [] });
  });

  it("counts from an app's start, so the first night after it doesn't flag", () => {
    const started = { ...running, startedAt: new Date(NOW.getTime() - 12 * HOUR) };
    expect(overdueBackupJobs([job({ lastRunAt: stale, apps: [started] })], NOW)).toEqual([]);

    const long = { ...running, startedAt: new Date(NOW.getTime() - 3 * DAY) };
    const [entry] = overdueBackupJobs([job({ lastRunAt: stale, apps: [long] })], NOW);
    expect(entry.since).toEqual(long.startedAt);
  });

  it("ignores a start on an app that is stopped again", () => {
    const restopped = { ...parked, startedAt: new Date(NOW.getTime() - 12 * HOUR) };
    expect(backupJobStaleness([job({ lastRunAt: stale, apps: [restopped] })], NOW).stopped).toHaveLength(1);
  });
});
