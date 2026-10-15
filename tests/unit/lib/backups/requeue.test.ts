// A restart cut off the nightly backups mid-run. The next console reruns them once and the summary still lands.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BackupRunPlan } from "@/lib/backups/run-rules";

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  markJobDone: vi.fn(),
  reap: vi.fn(),
  draining: false,
  /** Lock keys taken, as Redis SET NX would hold them. */
  locks: new Set<string>(),
  releaseLock: vi.fn(),
  leasesHeld: new Set<string>(),
}));

vi.mock("@/lib/db", async () => {
  const { dbMock } = await import("@/tests/helpers/db");
  const select = () => ({ from: () => ({ where: async () => mocks.selectRows }) });
  return { db: { ...dbMock.db, query: dbMock.query, select } };
});
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/backups/engine", () => ({ REQUEUE_TRIGGER: "requeue" }));
vi.mock("@/lib/backups/reap", () => ({
  INTERRUPTED_REASON: "Backup interrupted",
  reapInterruptedBackups: mocks.reap,
}));
vi.mock("@/lib/backups/runs", () => ({ markJobDone: mocks.markJobDone }));
vi.mock("@/lib/backups/in-flight", () => ({ backupsDraining: () => mocks.draining }));
vi.mock("@/lib/redis-lock", () => ({
  acquireLock: async (key: string) => {
    if (mocks.locks.has(key)) return null;
    mocks.locks.add(key);
    return `token:${key}`;
  },
  releaseLock: async (key: string, token: string) => {
    mocks.releaseLock(key, token);
    return mocks.locks.delete(key);
  },
}));
vi.mock("@/lib/backups/run-lease", () => ({
  runJobLeaseHeld: async (runId: string, jobId: string) => mocks.leasesHeld.has(`${runId}:${jobId}`),
}));

import { dbMock } from "@/tests/helpers/db";
import { backupRuns, backups } from "@/lib/db/schema";
import {
  planRequeues,
  requeueInterruptedBackups,
  requeueLockKey,
  requeueOrphanedRunJobs,
  requeueWindowMs,
  sweepInterruptedBackups,
} from "@/lib/backups/requeue";

const NOW = new Date("2026-10-10T03:00:00Z");
const at = (iso: string) => new Date(`2026-10-10T${iso}Z`);

const plan = (jobIds: string[]): BackupRunPlan => ({
  jobs: jobIds.map((jobId) => ({ jobId, jobName: jobId })),
  apps: [],
  target: null,
});

function nightlyRun(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    organizationId: "org-1",
    startedAt: at("02:00:00"),
    estimatedMs: 20 * 60_000,
    deadlineAt: at("03:00:00"),
    finishedAt: null,
    plan: plan(["job-1", "job-2"]),
    jobsDone: ["job-2"],
    ...over,
  };
}

const runJob = vi.fn((): Promise<void> | false => Promise.resolve());

beforeEach(() => {
  dbMock.reset();
  runJob.mockClear();
  mocks.markJobDone.mockReset();
  mocks.reap.mockReset();
  mocks.draining = false;
  mocks.locks.clear();
  mocks.releaseLock.mockReset();
  mocks.leasesHeld.clear();
  mocks.selectRows = [{ id: "b-1", jobId: "job-1", startedAt: at("02:10:00") }];
  dbMock.query.backupJobs.findFirst.mockResolvedValue({ id: "job-1", name: "Nightly", enabled: true, organizationId: "org-1" });
  dbMock.query.backups.findFirst.mockResolvedValue(undefined);
  dbMock.query.backupRuns.findMany.mockResolvedValue([nightlyRun()]);
  dbMock.updateReturns([{ id: "b-1" }]);
});

describe("planRequeues", () => {
  it("reruns each job once, after its last cut-off row", () => {
    const plans = planRequeues([
      { id: "b-1", jobId: "j1", startedAt: at("02:01:00") },
      { id: "b-2", jobId: "j1", startedAt: at("02:05:00") },
      { id: "b-3", jobId: "j1", startedAt: at("02:03:00") },
      { id: "b-4", jobId: "j2", startedAt: at("02:02:00") },
    ]);

    expect(plans).toEqual([
      { jobId: "j1", rowIds: ["b-1", "b-2", "b-3"], latestStartedAt: at("02:05:00") },
      { jobId: "j2", rowIds: ["b-4"], latestStartedAt: at("02:02:00") },
    ]);
  });
});

describe("requeueInterruptedBackups", () => {
  it("reruns an interrupted nightly job into its open run and pushes the run's deadline out", async () => {
    const started = await requeueInterruptedBackups(NOW, { runJob });

    expect(started).toEqual(["job-1"]);
    expect(runJob).toHaveBeenCalledWith(
      { id: "job-1", name: "Nightly" },
      { runId: "run-1", trigger: "requeue" },
    );
    expect(dbMock.updates[0].table).toBe(backups);
    const deadline = dbMock.updates.find((u) => u.table === backupRuns)?.set as { deadlineAt: Date };
    expect(deadline.deadlineAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 60 * 60_000);
  });

  it("leaves the deadline alone when it already covers the rerun", async () => {
    dbMock.query.backupRuns.findMany.mockResolvedValue([nightlyRun({ deadlineAt: at("08:00:00") })]);

    await requeueInterruptedBackups(NOW, { runJob });

    expect(dbMock.updates.some((u) => u.table === backupRuns)).toBe(false);
  });

  it("runs without a run when none is waiting on the job", async () => {
    dbMock.query.backupRuns.findMany.mockResolvedValue([nightlyRun({ jobsDone: ["job-1", "job-2"] })]);

    await requeueInterruptedBackups(NOW, { runJob });

    expect(runJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ runId: null }));
  });

  it("does nothing when another console claimed the rows first", async () => {
    dbMock.updateReturns([]);

    expect(await requeueInterruptedBackups(NOW, { runJob })).toEqual([]);
    expect(runJob).not.toHaveBeenCalled();
    expect(mocks.markJobDone).not.toHaveBeenCalled();
  });

  it("skips a job that's off, and reports it done so the summary isn't held", async () => {
    dbMock.query.backupJobs.findFirst.mockResolvedValue({ id: "job-1", name: "Nightly", enabled: false, organizationId: "org-1" });

    expect(await requeueInterruptedBackups(NOW, { runJob })).toEqual([]);
    expect(runJob).not.toHaveBeenCalled();
    expect(mocks.markJobDone).toHaveBeenCalledWith("run-1", "job-1");
  });

  it("skips a job a later run already covered", async () => {
    dbMock.query.backups.findFirst.mockResolvedValue({ id: "b-later" });

    expect(await requeueInterruptedBackups(NOW, { runJob })).toEqual([]);
    expect(runJob).not.toHaveBeenCalled();
    expect(mocks.markJobDone).toHaveBeenCalledWith("run-1", "job-1");
  });

  it("takes the run's one requeue of the job, so the orphan sweep can't run it again", async () => {
    await requeueInterruptedBackups(NOW, { runJob });

    expect(mocks.locks.has(requeueLockKey("run-1", "job-1"))).toBe(true);
  });

  it("does nothing with no interrupted rows", async () => {
    mocks.selectRows = [];

    expect(await requeueInterruptedBackups(NOW, { runJob })).toEqual([]);
    expect(dbMock.updates).toEqual([]);
  });
});

describe("requeueOrphanedRunJobs", () => {
  // The run opened at 02:00; job-1 was waiting for a slot when its console died, so it never got a row.
  const leasedRun = (over: Partial<Record<string, unknown>> = {}) =>
    nightlyRun({ plan: { ...plan(["job-1", "job-2"]), jobLeases: true }, ...over });

  beforeEach(() => {
    dbMock.query.backupRuns.findMany.mockResolvedValue([leasedRun()]);
  });

  it("reruns a planned job that never started once no process holds it, and pushes the deadline out", async () => {
    const started = await requeueOrphanedRunJobs(NOW, { runJob });

    expect(started).toEqual(["job-1"]);
    expect(runJob).toHaveBeenCalledOnce();
    expect(runJob).toHaveBeenCalledWith({ id: "job-1", name: "Nightly" }, { runId: "run-1", trigger: "requeue" });
    const deadline = dbMock.updates.find((u) => u.table === backupRuns)?.set as { deadlineAt: Date };
    expect(deadline.deadlineAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 60 * 60_000);
  });

  it("leaves a job alone while a live process holds its lease", async () => {
    mocks.leasesHeld.add("run-1:job-1");

    expect(await requeueOrphanedRunJobs(NOW, { runJob })).toEqual([]);
    expect(runJob).not.toHaveBeenCalled();
  });

  it("leaves a job alone while it has a running row", async () => {
    dbMock.query.backups.findFirst.mockResolvedValue({ id: "b-running" });

    expect(await requeueOrphanedRunJobs(NOW, { runJob })).toEqual([]);
    expect(runJob).not.toHaveBeenCalled();
  });

  it("runs a job once across two consoles sweeping together", async () => {
    const [a, b] = await Promise.all([requeueOrphanedRunJobs(NOW, { runJob }), requeueOrphanedRunJobs(NOW, { runJob })]);

    expect([...a, ...b]).toEqual(["job-1"]);
    expect(runJob).toHaveBeenCalledOnce();
  });

  it("doesn't run a job a second time on a later sweep", async () => {
    await requeueOrphanedRunJobs(NOW, { runJob });
    await requeueOrphanedRunJobs(new Date(NOW.getTime() + 5 * 60_000), { runJob });

    expect(runJob).toHaveBeenCalledOnce();
  });

  it("doesn't rerun a job the interrupted-row sweep already requeued into the run", async () => {
    await requeueInterruptedBackups(NOW, { runJob });
    runJob.mockClear();

    expect(await requeueOrphanedRunJobs(NOW, { runJob })).toEqual([]);
    expect(runJob).not.toHaveBeenCalled();
  });

  it("gives the claim back when the job is already queued here", async () => {
    runJob.mockReturnValueOnce(false);

    expect(await requeueOrphanedRunJobs(NOW, { runJob })).toEqual([]);
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
    expect(await requeueOrphanedRunJobs(NOW, { runJob })).toEqual(["job-1"]);
  });

  it("leaves runs opened before job leases alone", async () => {
    dbMock.query.backupRuns.findMany.mockResolvedValue([nightlyRun()]);

    expect(await requeueOrphanedRunJobs(NOW, { runJob })).toEqual([]);
  });

  it("waits out the grace on a run that just opened", async () => {
    dbMock.query.backupRuns.findMany.mockResolvedValue([leasedRun({ startedAt: new Date(NOW.getTime() - 30_000) })]);

    expect(await requeueOrphanedRunJobs(NOW, { runJob })).toEqual([]);
  });

  it("reports a job that's off as done instead of running it", async () => {
    dbMock.query.backupJobs.findFirst.mockResolvedValue({ id: "job-1", name: "Nightly", enabled: false });

    expect(await requeueOrphanedRunJobs(NOW, { runJob })).toEqual([]);
    expect(mocks.markJobDone).toHaveBeenCalledWith("run-1", "job-1");
  });
});

describe("sweepInterruptedBackups", () => {
  it("reaps only rows old enough to have their lease", async () => {
    mocks.selectRows = [];
    await sweepInterruptedBackups(NOW);

    expect(mocks.reap).toHaveBeenCalledWith(NOW, { minAgeMs: 60_000 });
  });

  it("also queries open runs for jobs a dead console never started", async () => {
    mocks.selectRows = [];
    dbMock.query.backupRuns.findMany.mockResolvedValue([]);
    await sweepInterruptedBackups(NOW);

    expect(dbMock.query.backupRuns.findMany).toHaveBeenCalled();
  });

  it("leaves everything to the next console while this one drains", async () => {
    mocks.draining = true;
    await sweepInterruptedBackups(NOW);

    expect(mocks.reap).not.toHaveBeenCalled();
  });
});

describe("requeueWindowMs", () => {
  it("defaults to 12 hours and reads VARDO_BACKUP_REQUEUE_HOURS", () => {
    expect(requeueWindowMs({})).toBe(12 * 60 * 60_000);
    expect(requeueWindowMs({ VARDO_BACKUP_REQUEUE_HOURS: "2" })).toBe(2 * 60 * 60_000);
  });
});
