import { describe, it, expect } from "vitest";
import { archiveSize, asRecent, isJobOverdue, jobNeedsLook, latestFinished, runMark } from "@/components/backups/job-state";
import type { BackupJob, JobRun } from "@/components/backups/types";

const NOW = new Date("2026-10-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

function job(over: Partial<BackupJob> = {}, runs: Partial<JobRun>[] = []): BackupJob {
  return {
    id: "j1",
    name: "Nightly",
    schedule: "0 2 * * *",
    enabled: true,
    keepLast: null,
    keepDaily: null,
    keepWeekly: null,
    keepMonthly: null,
    createdAt: hoursAgo(24 * 30),
    lastRunAt: hoursAgo(10),
    target: { id: "t", name: "Local", type: "local" },
    backupJobApps: [],
    backups: runs.map((r, i) => ({ id: `b${i}`, status: "success", sizeBytes: 1, startedAt: hoursAgo(i), finishedAt: null, ...r })),
    ...over,
  };
}

describe("runMark", () => {
  it("keeps good runs quiet and flags the rest", () => {
    expect(runMark("success").tone).toBe("good");
    expect(runMark("failed").tone).toBe("issue");
    expect(runMark("skipped").tone).toBe("warn");
    expect(runMark("running").pending).toBe(true);
  });
});

describe("job health", () => {
  it("is overdue after two missed runs", () => {
    expect(isJobOverdue(job({ lastRunAt: hoursAgo(10) }), NOW)).toBe(false);
    expect(isJobOverdue(job({ lastRunAt: hoursAgo(72) }), NOW)).toBe(true);
    expect(isJobOverdue(job({ lastRunAt: hoursAgo(72), enabled: false }), NOW)).toBe(false);
  });

  it("reads the newest finished run", () => {
    const j = job({}, [{ status: "running" }, { status: "failed" }]);
    expect(latestFinished(j)?.status).toBe("failed");
    expect(jobNeedsLook(j, NOW, false)).toBe(true);
    expect(jobNeedsLook(job({}, [{ status: "success" }]), NOW, false)).toBe(false);
    expect(jobNeedsLook(job({}, [{ status: "success" }]), NOW, true)).toBe(true);
  });
});

describe("asRecent", () => {
  it("attaches the job and fills what the list left out", () => {
    const r = asRecent({ id: "j1", name: "Nightly" }, { id: "b", status: "success", sizeBytes: 5, startedAt: hoursAgo(1), finishedAt: null });
    expect(r.job).toEqual({ id: "j1", name: "Nightly" });
    expect(r.storagePath).toBeNull();
  });
});

describe("archiveSize", () => {
  it("names an empty archive and a missing size", () => {
    expect(archiveSize(null)).toBe("—");
    expect(archiveSize(10)).toBe("Empty");
  });
});
