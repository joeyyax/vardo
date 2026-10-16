import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const held = new Map<string, { by: string; startedAt: Date }>();
  return {
    held,
    runBackup: vi.fn(),
    runRestoreDrill: vi.fn(),
    claimJob: vi.fn(async (jobId: string, by: string, startedAt = new Date()) => {
      if (held.has(jobId)) return null;
      held.set(jobId, { by, startedAt });
      return async () => {
        held.delete(jobId);
      };
    }),
    nightlyRunStartedSince: vi.fn(),
    startManualRun: vi.fn(),
    markJobDone: vi.fn(),
  };
});

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/backups/job-claim", () => ({ claimJob: h.claimJob, jobClaimHolder: async (jobId: string) => h.held.get(jobId) ?? null }));
vi.mock("@/lib/backups/runs", () => ({
  nightlyRunStartedSince: h.nightlyRunStartedSince,
  startManualRun: h.startManualRun,
  markJobDone: h.markJobDone,
}));
vi.mock("@/lib/backups/engine", () => ({ MANUAL_TRIGGER: "manual", STALE_RUN_MS: 3_600_000, runBackup: h.runBackup }));
vi.mock("@/lib/backups/drill", () => ({ runRestoreDrill: h.runRestoreDrill }));
vi.mock("@/lib/resources/host", () => ({ loadResourceSettings: async () => ({}), maxBackupConcurrency: async () => 1 }));

import { dbMock } from "@/tests/helpers/db";
import { backupSlotsBusy, withBackupSlot } from "@/lib/backups/run-limit";
const { runManualDrill, startManualBackup } = await import("@/lib/backups/manual-run");

/** Holds the only backup slot, as a nightly run would, until released. */
async function fillSlot() {
  let release!: () => void;
  const running = withBackupSlot(1, () => new Promise<void>((r) => (release = r)));
  await vi.waitFor(() => expect(release).toBeDefined());
  return async () => {
    release();
    await running;
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("startManualBackup", () => {
  beforeEach(() => {
    dbMock.reset();
    h.held.clear();
    vi.clearAllMocks();
    dbMock.query.backups.findFirst.mockResolvedValue(undefined);
    dbMock.query.backupJobs.findFirst.mockResolvedValue({ id: "j1", name: "Auto: Shop", organizationId: "org1" });
    h.nightlyRunStartedSince.mockResolvedValue(null);
    h.startManualRun.mockResolvedValue("run_m");
    h.markJobDone.mockResolvedValue(undefined);
  });

  it("runs a job once when two requests land together", async () => {
    let finish!: () => void;
    h.runBackup.mockReturnValue(new Promise<never[]>((r) => (finish = () => r([]))));
    const [a, b] = await Promise.all([startManualBackup("j1"), startManualBackup("j1")]);
    expect([a.started, b.started].sort()).toEqual([false, true]);
    await vi.waitFor(() => expect(h.runBackup).toHaveBeenCalledTimes(1));
    expect(h.runBackup).toHaveBeenCalledWith("j1", { trigger: "manual", runId: "run_m" });

    finish();
    await (a.started ? a.done : b.started ? b.done : null);
    const again = await startManualBackup("j1");
    expect(again.started).toBe(true);
    await (again.started && again.done);
  });

  it("uses a backup of the job running elsewhere", async () => {
    const startedAt = new Date("2026-10-13T21:59:00Z");
    dbMock.query.backups.findFirst.mockResolvedValue({ startedAt });
    expect(await startManualBackup("j1")).toEqual({ started: false, startedAt });
    expect(h.runBackup).not.toHaveBeenCalled();
    expect(h.held.size).toBe(0);
  });

  it("uses a nightly run of the job that started in the last few minutes", async () => {
    const startedAt = new Date(Date.now() - 2 * 60_000);
    h.nightlyRunStartedSince.mockResolvedValue(startedAt);
    expect(await startManualBackup("j1")).toEqual({ started: false, startedAt });
    const since = h.nightlyRunStartedSince.mock.calls[0][1] as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(5 * 60_000);
    expect(Date.now() - since.getTime()).toBeLessThan(5 * 60_000 + 1_000);
    expect(h.runBackup).not.toHaveBeenCalled();
    expect(h.held.size).toBe(0);
  });

  it("starts past a wedged backup row and a recent nightly run with force", async () => {
    dbMock.query.backups.findFirst.mockResolvedValue({ startedAt: new Date(Date.now() - 30 * 60_000) });
    h.nightlyRunStartedSince.mockResolvedValue(new Date());
    h.runBackup.mockResolvedValue([]);
    const start = await startManualBackup("j1", { appIds: ["a1"], force: true });
    expect(start.started).toBe(true);
    await vi.waitFor(() => expect(h.runBackup).toHaveBeenCalledWith("j1", { appIds: ["a1"], trigger: "manual", runId: "run_m" }));
    expect(h.startManualRun).toHaveBeenCalledWith(expect.objectContaining({ id: "j1" }), expect.any(Date), ["a1"]);
    await (start.started && start.done);
    expect(h.held.size).toBe(0);
  });

  it("never starts past a run that holds the job, even with force", async () => {
    const startedAt = new Date("2026-10-15T02:00:00Z");
    h.held.set("j1", { by: "scheduled", startedAt });
    expect(await startManualBackup("j1", { appIds: ["a1"], force: true })).toEqual({ started: false, startedAt });
    await settle();
    expect(h.runBackup).not.toHaveBeenCalled();
    expect(h.startManualRun).not.toHaveBeenCalled();
    expect(h.held.get("j1")).toEqual({ by: "scheduled", startedAt });
  });

  it("opens its run and holds the job before waiting for a slot, and reports when done", async () => {
    h.runBackup.mockResolvedValue([]);
    const free = await fillSlot();
    const start = await startManualBackup("j1");
    expect(start.started).toBe(true);

    await settle();
    expect(h.runBackup).not.toHaveBeenCalled();
    expect(h.startManualRun).toHaveBeenCalledTimes(1);
    expect(h.held.get("j1")?.by).toBe("manual");
    expect(backupSlotsBusy()).toBe(true);

    await free();
    await (start.started && start.done);
    expect(h.runBackup).toHaveBeenCalledTimes(1);
    expect(h.markJobDone).toHaveBeenCalledWith("run_m", "j1");
    expect(h.held.size).toBe(0);
    expect(backupSlotsBusy()).toBe(false);
  });

  it("runs an instance-level job with no run of its own", async () => {
    h.startManualRun.mockResolvedValue(null);
    h.runBackup.mockResolvedValue([]);
    const start = await startManualBackup("j1");
    await (start.started && start.done);
    expect(h.runBackup).toHaveBeenCalledWith("j1", { trigger: "manual" });
    expect(h.markJobDone).not.toHaveBeenCalled();
  });
});

describe("runManualDrill", () => {
  beforeEach(() => vi.clearAllMocks());

  it("waits for a backup slot while every one is busy", async () => {
    h.runRestoreDrill.mockResolvedValue({ outcome: "verified" });
    const free = await fillSlot();
    const drill = runManualDrill("b1");

    await settle();
    expect(h.runRestoreDrill).not.toHaveBeenCalled();

    await free();
    expect(await drill).toEqual({ outcome: "verified" });
    expect(h.runRestoreDrill).toHaveBeenCalledWith("b1");
  });
});
