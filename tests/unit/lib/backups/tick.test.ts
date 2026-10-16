// Scheduler coverage for two silent failures:
//  1. The "already running" guard had no time bound, so a backup row orphaned by
//     a process death (self-deploy, OOM, reboot) skipped the job forever.
//  2. The tick stamped lastRunAt before running, so a run that captured nothing
//     still read as "backed up just now" and backup-stale never fired.
//
// The guard lives in SQL, so drizzle's operators are stubbed into inspectable
// nodes and the resulting predicate is evaluated against a candidate row —
// asserting what the query would actually match, not how it was built.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { backupJobsFindMany, backupsFindFirst, runBackupMock, acquireLockMock, shouldRunNowMock, needsSetupMock, adoptMock, updates, limit, nightly, leases, claims } =
  vi.hoisted(() => ({
    limit: { value: 1 },
    nightly: { value: new Map<string, string>() },
    /** Job claims held now, by job. */
    claims: new Map<string, { by: string; startedAt: Date }>(),
    adoptMock: vi.fn(),
    /** Run job leases held now, and every take, report and release in order. */
    leases: { held: new Set<string>(), events: [] as string[] },
    backupJobsFindMany: vi.fn(),
    backupsFindFirst: vi.fn(),
    runBackupMock: vi.fn(),
    acquireLockMock: vi.fn(),
    shouldRunNowMock: vi.fn(),
    needsSetupMock: vi.fn(),
    updates: [] as { set: Record<string, unknown> }[],
  }));

type Node = {
  kind: string;
  col?: string;
  value?: unknown;
  values?: unknown[];
  parts?: Node[];
};

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (col: { name: string }, value: unknown): Node => ({ kind: "eq", col: col.name, value }),
  gt: (col: { name: string }, value: unknown): Node => ({ kind: "gt", col: col.name, value }),
  inArray: (col: { name: string }, values: unknown[]): Node => ({ kind: "inArray", col: col.name, values }),
  and: (...parts: Node[]): Node => ({ kind: "and", parts }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      backupJobs: { findMany: backupJobsFindMany },
      backups: { findFirst: backupsFindFirst },
    },
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ set });
        },
      }),
    }),
  },
}));
vi.mock("@/lib/cron/parse", () => ({ shouldRunNow: shouldRunNowMock }));
vi.mock("@/lib/resources/host", () => ({
  loadResourceSettings: async () => ({}),
  maxBackupConcurrency: async () => limit.value,
}));
vi.mock("@/lib/setup", () => ({ needsSetup: needsSetupMock }));
vi.mock("@/lib/redis-lock", () => ({ acquireLock: acquireLockMock }));
vi.mock("@/lib/backups/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backups/engine")>()),
  runBackup: runBackupMock,
}));
vi.mock("@/lib/backups/initial-backup", () => ({ startDueInitialBackups: async () => [] }));
vi.mock("@/lib/backups/job-claim", () => {
  const claimJob = async (jobId: string, by: string, startedAt = new Date()) => {
    if (claims.has(jobId)) return null;
    claims.set(jobId, { by, startedAt });
    return async () => {
      claims.delete(jobId);
    };
  };
  return {
    claimJob,
    jobClaimHolder: async (jobId: string) => claims.get(jobId) ?? null,
    claimJobWhenFree: async (jobId: string, by: string) => {
      for (;;) {
        const release = await claimJob(jobId, by);
        if (release) return release;
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
});
vi.mock("@/lib/backups/runs", () => ({
  adoptManualRun: adoptMock,
  nightlyRunStart: async () => null,
  startNightlyRuns: async () => nightly.value,
  startJobRun: async () => null,
  markJobDone: async (runId: string, jobId: string) => {
    leases.events.push(`done ${runId}:${jobId}`);
  },
}));
vi.mock("@/lib/backups/run-lease", () => ({
  holdRunJobLease: async (runId: string, jobId: string) => {
    const key = `${runId}:${jobId}`;
    leases.held.add(key);
    leases.events.push(`hold ${key}`);
    return async () => {
      leases.held.delete(key);
      leases.events.push(`release ${key}`);
    };
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { tickBackupJobs } from "@/lib/backups/tick";
import { STALE_RUN_MS } from "@/lib/backups/engine";

/** Would the built predicate select this row? */
function matches(node: Node, row: Record<string, unknown>): boolean {
  switch (node.kind) {
    case "and":
      return (node.parts ?? []).every((p) => matches(p, row));
    case "eq":
      return row[node.col!] === node.value;
    case "gt":
      return (row[node.col!] as Date).getTime() > (node.value as Date).getTime();
    case "inArray":
      return (node.values ?? []).includes(row[node.col!]);
    default:
      throw new Error(`Unhandled predicate node: ${node.kind}`);
  }
}

/** Row keys are DB column names, matching what the stubbed operators capture. */
function inFlightRow(startedAt: Date) {
  return { id: "bk-wedged", job_id: "job-1", status: "running", started_at: startedAt };
}

/** Serve `row` from backups.findFirst only when the predicate actually selects it. */
function withExistingBackup(row: Record<string, unknown> | null) {
  backupsFindFirst.mockImplementation(async ({ where }: { where: Node }) =>
    row && matches(where, row) ? row : undefined,
  );
}

beforeEach(() => {
  updates.length = 0;
  backupJobsFindMany.mockReset().mockResolvedValue([
    { id: "job-1", name: "Nightly", schedule: "0 3 * * *", enabled: true },
  ]);
  backupsFindFirst.mockReset();
  runBackupMock.mockReset().mockResolvedValue([]);
  acquireLockMock.mockReset().mockResolvedValue(true);
  shouldRunNowMock.mockReset().mockReturnValue(true);
  needsSetupMock.mockReset().mockResolvedValue(false);
  limit.value = 1;
  nightly.value = new Map();
  leases.held.clear();
  leases.events.length = 0;
  claims.clear();
  adoptMock.mockReset().mockResolvedValue(false);
});

describe("tickBackupJobs — before first-run setup", () => {
  it("runs nothing while setup is still open", async () => {
    needsSetupMock.mockResolvedValue(true);
    withExistingBackup(null);
    await tickBackupJobs();
    expect(runBackupMock).not.toHaveBeenCalled();
  });

  it("runs a due job once setup is done", async () => {
    withExistingBackup(null);
    await tickBackupJobs();
    expect(runBackupMock).toHaveBeenCalledWith("job-1", { runId: null });
  });
});

describe("tickBackupJobs — the in-flight guard is time-bounded", () => {
  it("runs the job when the only running row is older than the stale window", async () => {
    withExistingBackup(inFlightRow(new Date(Date.now() - STALE_RUN_MS - 60_000)));

    await tickBackupJobs();

    expect(runBackupMock).toHaveBeenCalledWith("job-1", { runId: null });
  });

  it("still skips while a backup is genuinely in flight", async () => {
    withExistingBackup(inFlightRow(new Date(Date.now() - 60_000)));

    await tickBackupJobs();

    expect(runBackupMock).not.toHaveBeenCalled();
  });

  it("skips a pending row the same way it skips a running one", async () => {
    withExistingBackup({ ...inFlightRow(new Date(Date.now() - 60_000)), status: "pending" });

    await tickBackupJobs();

    expect(runBackupMock).not.toHaveBeenCalled();
  });

  it("runs when no backup row exists at all", async () => {
    withExistingBackup(null);

    await tickBackupJobs();

    expect(runBackupMock).toHaveBeenCalledWith("job-1", { runId: null });
  });
});

describe("tickBackupJobs — lastRunAt is left to the engine", () => {
  it("does not stamp lastRunAt for a run that captured nothing", async () => {
    withExistingBackup(null);
    runBackupMock.mockResolvedValue([]);

    await tickBackupJobs();

    expect(runBackupMock).toHaveBeenCalled();
    expect(updates.some((u) => "lastRunAt" in u.set)).toBe(false);
  });

  it("does not stamp lastRunAt for a run whose backups all failed", async () => {
    withExistingBackup(null);
    runBackupMock.mockResolvedValue([
      { backupId: "bk-1", appId: "app-a", volumeName: "data", outcome: "failed", sizeBytes: 0, storagePath: "", durationMs: 5 },
    ]);

    await tickBackupJobs();

    expect(updates.some((u) => "lastRunAt" in u.set)).toBe(false);
  });
});

describe("tickBackupJobs — jobs due together", () => {
  /** A runBackup whose runs finish only when released, recording which are in flight. */
  function heldRuns() {
    const inFlight = new Set<string>();
    let peak = 0;
    const release = new Map<string, () => void>();
    runBackupMock.mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          inFlight.add(id);
          peak = Math.max(peak, inFlight.size);
          release.set(id, () => {
            inFlight.delete(id);
            resolve([]);
          });
        }),
    );
    return { inFlight, release, peak: () => peak };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const jobs = (...ids: string[]) => ids.map((id) => ({ id, name: id, schedule: "0 2 * * *", enabled: true }));

  it("runs same-minute jobs one at a time on a one-slot host", async () => {
    withExistingBackup(null);
    backupJobsFindMany.mockResolvedValue(jobs("a", "b", "c"));
    const runs = heldRuns();

    const tick = tickBackupJobs();
    await settle();
    expect([...runs.inFlight]).toEqual(["a"]);
    runs.release.get("a")!();
    await settle();
    expect([...runs.inFlight]).toEqual(["b"]);
    runs.release.get("b")!();
    await settle();
    runs.release.get("c")!();
    await tick;
    expect(runs.peak()).toBe(1);
  });

  it("runs up to the backup concurrency at once", async () => {
    limit.value = 2;
    withExistingBackup(null);
    backupJobsFindMany.mockResolvedValue(jobs("a", "b", "c"));
    const runs = heldRuns();

    const tick = tickBackupJobs();
    await settle();
    expect([...runs.inFlight].sort()).toEqual(["a", "b"]);
    for (const id of ["a", "b"]) runs.release.get(id)!();
    await settle();
    runs.release.get("c")!();
    await tick;
    expect(runs.peak()).toBe(2);
  });

  it("caps runs across overlapping ticks and skips a job still waiting", async () => {
    withExistingBackup(null);
    backupJobsFindMany.mockResolvedValue(jobs("a", "b"));
    const runs = heldRuns();

    const first = tickBackupJobs();
    await settle();
    const second = tickBackupJobs();
    await settle();
    expect([...runs.inFlight]).toEqual(["a"]);

    runs.release.get("a")!();
    await settle();
    runs.release.get("b")!();
    await Promise.all([first, second]);
    expect(runBackupMock).toHaveBeenCalledTimes(2);
    expect(runs.peak()).toBe(1);
  });
});

describe("tickBackupJobs — run job leases", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const nightlyJobs = (...ids: string[]) => ids.map((id) => ({ id, name: id, schedule: "", enabled: true, nightly: true }));

  it("holds each nightly job's lease from the run's start until the job reports", async () => {
    withExistingBackup(null);
    nightly.value = new Map([["a", "run-1"], ["b", "run-1"]]);
    backupJobsFindMany.mockResolvedValue(nightlyJobs("a", "b"));
    const release = new Map<string, () => void>();
    runBackupMock.mockImplementation((id: string) => new Promise((resolve) => release.set(id, () => resolve([]))));

    const tick = tickBackupJobs();
    await settle();
    // b waits for the one slot, still leased.
    expect([...leases.held].sort()).toEqual(["run-1:a", "run-1:b"]);

    release.get("a")!();
    await settle();
    expect([...leases.held]).toEqual(["run-1:b"]);

    await settle();
    release.get("b")!();
    await tick;
    expect(leases.held.size).toBe(0);
    expect(leases.events.indexOf("done run-1:b")).toBeLessThan(leases.events.indexOf("release run-1:b"));
  });

  it("frees the lease of a nightly job this tick didn't take", async () => {
    withExistingBackup(null);
    nightly.value = new Map([["a", "run-1"]]);
    backupJobsFindMany.mockResolvedValue(nightlyJobs("a"));
    acquireLockMock.mockResolvedValue(null);

    await tickBackupJobs();

    expect(runBackupMock).not.toHaveBeenCalled();
    expect(leases.held.size).toBe(0);
  });

  it("keeps a skipped job's lease until it's reported done", async () => {
    nightly.value = new Map([["a", "run-1"]]);
    backupJobsFindMany.mockResolvedValue(nightlyJobs("a"));
    backupsFindFirst.mockResolvedValue({ id: "bk-running" });

    await tickBackupJobs();
    await settle();

    expect(leases.events).toEqual(["hold run-1:a", "done run-1:a", "release run-1:a"]);
  });
});

describe("tickBackupJobs — one run of a job at a time", () => {
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const nightlyJobs = (...ids: string[]) => ids.map((id) => ({ id, name: id, schedule: "", enabled: true, nightly: true }));

  it("skips a scheduled job while a run started by hand holds it", async () => {
    withExistingBackup(null);
    claims.set("job-1", { by: "manual", startedAt: new Date() });

    await tickBackupJobs();

    expect(runBackupMock).not.toHaveBeenCalled();
    expect(claims.get("job-1")?.by).toBe("manual");
  });

  it("holds the job while it runs and lets go after", async () => {
    withExistingBackup(null);
    let finish!: () => void;
    runBackupMock.mockImplementation(() => new Promise((r) => (finish = () => r([]))));

    const tick = tickBackupJobs();
    await settle();
    expect(claims.get("job-1")?.by).toBe("scheduled");
    finish();
    await tick;
    expect(claims.size).toBe(0);
  });

  it("waits out a nightly job's run started by hand, then takes its backup without running", async () => {
    withExistingBackup(null);
    nightly.value = new Map([["a", "run-1"]]);
    backupJobsFindMany.mockResolvedValue(nightlyJobs("a"));
    claims.set("a", { by: "manual", startedAt: new Date() });
    adoptMock.mockResolvedValue(true);

    const tick = tickBackupJobs();
    await settle();
    expect(adoptMock).not.toHaveBeenCalled();
    expect([...leases.held]).toEqual(["run-1:a"]);

    claims.delete("a");
    await tick;
    expect(adoptMock).toHaveBeenCalledWith("run-1", "a", expect.any(Date));
    expect(runBackupMock).not.toHaveBeenCalled();
    // The adoption marks it done; nothing else does.
    expect(leases.events).toEqual(["hold run-1:a", "release run-1:a"]);
    expect(claims.size).toBe(0);
  });

  it("runs a nightly job itself when there's no manual backup to take", async () => {
    withExistingBackup(null);
    nightly.value = new Map([["a", "run-1"]]);
    backupJobsFindMany.mockResolvedValue(nightlyJobs("a"));

    await tickBackupJobs();

    expect(runBackupMock).toHaveBeenCalledWith("a", { runId: "run-1" });
    expect(leases.events).toEqual(["hold run-1:a", "done run-1:a", "release run-1:a"]);
  });
});

describe("tickBackupJobs — while this console drains for a stop", () => {
  it("starts nothing, leaving the schedule to the console replacing it", async () => {
    withExistingBackup(null);
    const { drainBackupsForStop, endBackupDrain } = await import("@/lib/backups/in-flight");
    await drainBackupsForStop(() => {}, 0, 1);
    try {
      await tickBackupJobs();
    } finally {
      endBackupDrain();
    }
    expect(runBackupMock).not.toHaveBeenCalled();
  });
});

describe("runRequeuedJob", () => {
  it("reruns the job with the requeue trigger, once while queued", async () => {
    const { runRequeuedJob } = await import("@/lib/backups/tick");
    let release!: () => void;
    runBackupMock.mockImplementationOnce(() => new Promise((r) => (release = () => r([]))));

    const first = runRequeuedJob({ id: "job-1", name: "Nightly" }, { runId: null, trigger: "requeue" });
    expect(runRequeuedJob({ id: "job-1", name: "Nightly" }, { runId: null, trigger: "requeue" })).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await first;

    expect(runBackupMock).toHaveBeenCalledOnce();
    expect(runBackupMock).toHaveBeenCalledWith("job-1", { runId: null, trigger: "requeue" });
  });

  it("holds the job's lease in its run until it reports", async () => {
    const { runRequeuedJob } = await import("@/lib/backups/tick");
    let release!: () => void;
    runBackupMock.mockImplementationOnce(() => new Promise((r) => (release = () => r([]))));

    const run = runRequeuedJob({ id: "job-1", name: "Nightly" }, { runId: "run-1", trigger: "requeue" });
    await new Promise((r) => setTimeout(r, 0));
    expect([...leases.held]).toEqual(["run-1:job-1"]);
    release();
    await run;

    expect(leases.held.size).toBe(0);
    expect(leases.events).toEqual(["hold run-1:job-1", "done run-1:job-1", "release run-1:job-1"]);
  });
});
