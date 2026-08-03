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

const { backupJobsFindMany, backupsFindFirst, runBackupMock, acquireLockMock, shouldRunNowMock, updates } =
  vi.hoisted(() => ({
    backupJobsFindMany: vi.fn(),
    backupsFindFirst: vi.fn(),
    runBackupMock: vi.fn(),
    acquireLockMock: vi.fn(),
    shouldRunNowMock: vi.fn(),
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
vi.mock("@/lib/redis-lock", () => ({ acquireLock: acquireLockMock }));
vi.mock("@/lib/backups/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backups/engine")>()),
  runBackup: runBackupMock,
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
});

describe("tickBackupJobs — the in-flight guard is time-bounded", () => {
  it("runs the job when the only running row is older than the stale window", async () => {
    withExistingBackup(inFlightRow(new Date(Date.now() - STALE_RUN_MS - 60_000)));

    await tickBackupJobs();

    expect(runBackupMock).toHaveBeenCalledWith("job-1");
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

    expect(runBackupMock).toHaveBeenCalledWith("job-1");
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
