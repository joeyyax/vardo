// #910: a new app sat unprotected until its first scheduled run, often most of a day away.

import { describe, it, expect, beforeEach, vi } from "vitest";

const m = vi.hoisted(() => ({
  appsFindFirst: vi.fn(),
  initialFindFirst: vi.fn(),
  initialFindMany: vi.fn(),
  jobAppsFindMany: vi.fn(),
  backupsFindFirst: vi.fn(),
  deploymentsFindFirst: vi.fn(),
  selfHealFindMany: vi.fn(),
  runBackup: vi.fn(),
  acquireLock: vi.fn(),
  importRunning: vi.fn(),
  switchState: vi.fn(),
  updates: [] as Record<string, unknown>[],
  inserts: [] as { values: Record<string, unknown>; set?: Record<string, unknown> }[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: m.appsFindFirst },
      initialBackups: { findFirst: m.initialFindFirst, findMany: m.initialFindMany },
      backupJobApps: { findMany: m.jobAppsFindMany },
      backups: { findFirst: m.backupsFindFirst },
      deployments: { findFirst: m.deploymentsFindFirst },
      containerSelfHeal: { findMany: m.selfHealFindMany },
    },
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          m.updates.push(set);
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
          m.inserts.push({ values, set });
        },
      }),
    }),
  },
}));
vi.mock("@/lib/backups/engine", () => ({
  runBackup: m.runBackup,
  runSucceeded: (r: { outcome: string }[]) => r.length > 0 && r.every((x) => x.outcome === "success"),
  STALE_RUN_MS: 3_600_000,
}));
vi.mock("@/lib/redis-lock", () => ({ acquireLock: m.acquireLock }));
vi.mock("@/lib/metrics/bulk-write", () => ({ isBulkWriteRunning: m.importRunning }));
vi.mock("@/lib/backups/switch", () => ({ resolveAppBackupSwitch: m.switchState }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  armInitialBackup,
  decideInitialStep,
  retryDelayMs,
  startDueInitialBackups,
  GIVE_UP_AFTER_MS,
  HEALTHY_WINDOW_MS,
  IMPORT_DELAY_MS,
  type InitialFacts,
} from "@/lib/backups/initial-backup";

const MIN = 60_000;
const NOW = new Date("2026-10-09T12:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const JOB = { backupJob: { id: "job1", organizationId: "org1", enabled: true } };

function facts(over: Partial<InitialFacts> = {}): InitialFacts {
  return {
    now: NOW,
    expiresAt: later(GIVE_UP_AFTER_MS),
    appStatus: "active",
    switchedOn: true,
    job: { id: "job1", enabled: true },
    alreadyCovered: false,
    troubleSinceArmed: false,
    importRunning: false,
    backupInFlight: false,
    ...over,
  };
}

function pending(over: Record<string, unknown> = {}) {
  return {
    appId: "app1",
    reason: "deploy",
    armedAt: new Date(NOW.getTime() - HEALTHY_WINDOW_MS),
    dueAt: NOW,
    expiresAt: later(GIVE_UP_AFTER_MS - HEALTHY_WINDOW_MS),
    attempts: 0,
    lastError: null,
    outcome: null,
    finishedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.updates.length = 0;
  m.inserts.length = 0;
  m.appsFindFirst.mockResolvedValue({ id: "app1", organizationId: "org1", status: "active" });
  m.initialFindFirst.mockResolvedValue(undefined);
  m.jobAppsFindMany.mockResolvedValue([JOB]);
  m.backupsFindFirst.mockResolvedValue(undefined);
  m.deploymentsFindFirst.mockResolvedValue(undefined);
  m.selfHealFindMany.mockResolvedValue([]);
  m.acquireLock.mockResolvedValue(true);
  m.importRunning.mockResolvedValue(false);
  m.switchState.mockResolvedValue({ enabled: true, source: "system" });
});

describe("retryDelayMs", () => {
  it("doubles from 15 minutes and caps at 4 hours", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => retryDelayMs(n) / MIN)).toEqual([15, 30, 60, 120, 240, 240]);
  });
});

describe("decideInitialStep", () => {
  it("runs a healthy app's job", () => {
    expect(decideInitialStep(facts())).toEqual({ kind: "run", jobId: "job1" });
  });

  it("gives up after the window", () => {
    expect(decideInitialStep(facts({ expiresAt: NOW }))).toEqual({ kind: "finish", outcome: "expired" });
  });

  it("finishes when a backup already landed", () => {
    expect(decideInitialStep(facts({ alreadyCovered: true }))).toEqual({ kind: "finish", outcome: "covered" });
  });

  it("skips an app switched off or without an enabled job", () => {
    expect(decideInitialStep(facts({ switchedOn: false })).kind).toBe("finish");
    expect(decideInitialStep(facts({ job: { id: "job1", enabled: false } })).kind).toBe("finish");
    expect(decideInitialStep(facts({ job: null })).kind).toBe("finish");
  });

  it("restarts the healthy window after a failed deploy, crash or stop", () => {
    for (const over of [{ troubleSinceArmed: true }, { appStatus: "error" }, { appStatus: "deploying" }]) {
      expect(decideInitialStep(facts(over))).toEqual({
        kind: "wait",
        dueAt: later(HEALTHY_WINDOW_MS),
        restartWindow: true,
      });
    }
  });

  it("waits out a running import or backup without restarting the window", () => {
    for (const over of [{ importRunning: true }, { backupInFlight: true }]) {
      expect(decideInitialStep(facts(over))).toEqual({ kind: "wait", dueAt: later(5 * MIN), restartWindow: false });
    }
  });
});

describe("armInitialBackup", () => {
  it("arms a covered app with no backups 15 minutes out", async () => {
    expect(await armInitialBackup("app1", "deploy", NOW)).toBe(true);
    expect(m.inserts[0].values).toMatchObject({
      appId: "app1",
      reason: "deploy",
      armedAt: NOW,
      dueAt: later(HEALTHY_WINDOW_MS),
      expiresAt: later(GIVE_UP_AFTER_MS),
      attempts: 0,
    });
  });

  it("skips an app with a successful or recent backup", async () => {
    m.backupsFindFirst.mockResolvedValue({ id: "b1" });
    expect(await armInitialBackup("app1", "deploy", NOW)).toBe(false);
    expect(m.inserts).toHaveLength(0);
  });

  it("skips an app no job covers", async () => {
    m.jobAppsFindMany.mockResolvedValue([{ backupJob: { id: "j", organizationId: "other", enabled: true } }]);
    expect(await armInitialBackup("app1", "deploy", NOW)).toBe(false);
  });

  it("never re-arms a finished snapshot on redeploy", async () => {
    m.initialFindFirst.mockResolvedValue(pending({ finishedAt: NOW, outcome: "success" }));
    expect(await armInitialBackup("app1", "deploy", NOW)).toBe(false);
    expect(m.updates).toHaveLength(0);
  });

  it("restarts the healthy window when a pending app redeploys", async () => {
    m.initialFindFirst.mockResolvedValue(pending());
    expect(await armInitialBackup("app1", "deploy", NOW)).toBe(true);
    expect(m.updates[0]).toEqual({ armedAt: NOW, dueAt: later(HEALTHY_WINDOW_MS) });
  });

  it("re-arms after an import even when backups exist", async () => {
    m.initialFindFirst.mockResolvedValue(pending({ finishedAt: NOW, outcome: "success" }));
    m.backupsFindFirst.mockResolvedValue({ id: "b1" });
    expect(await armInitialBackup("app1", "import", NOW)).toBe(true);
    expect(m.inserts[0].set).toMatchObject({ reason: "import", dueAt: later(IMPORT_DELAY_MS), finishedAt: null });
  });
});

describe("startDueInitialBackups", () => {
  const start = (queued = new Set<string>()) => startDueInitialBackups({ now: NOW, limit: 2, queued });

  it("claims the row, runs the app's job once and records success", async () => {
    m.initialFindMany.mockResolvedValue([pending()]);
    m.runBackup.mockResolvedValue([{ outcome: "success" }]);
    const queued = new Set<string>();

    const runs = await start(queued);
    expect(queued.has("job1")).toBe(true);
    await Promise.all(runs);

    expect(m.runBackup).toHaveBeenCalledWith("job1", { appIds: ["app1"], trigger: "initial", notifyFailure: false });
    expect(m.updates[0]).toEqual({ dueAt: later(HEALTHY_WINDOW_MS) });
    expect(m.updates.at(-1)).toMatchObject({ outcome: "success", attempts: 1 });
    expect(queued.size).toBe(0);
  });

  it("schedules a retry with backoff after a failure", async () => {
    m.initialFindMany.mockResolvedValue([pending({ attempts: 1 })]);
    m.runBackup.mockResolvedValue([{ outcome: "failed", error: "disk full" }]);

    await Promise.all(await start());

    const last = m.updates.at(-1)!;
    expect(last).toMatchObject({ attempts: 2, lastError: "disk full" });
    expect(last.outcome).toBeUndefined();
    expect((last.dueAt as Date).getTime() - Date.now()).toBeGreaterThan(29 * MIN);
  });

  it("gives up and notifies on the last attempt in the window", async () => {
    m.initialFindMany.mockResolvedValue([pending({ attempts: 4, expiresAt: new Date(Date.now() + 60 * MIN) })]);
    m.runBackup.mockRejectedValue(new Error("target unreachable"));

    await Promise.all(await start());

    expect(m.runBackup.mock.calls[0][1].notifyFailure).toBe(true);
    expect(m.updates.at(-1)).toMatchObject({ outcome: "expired", attempts: 5, lastError: "target unreachable" });
  });

  it("tags an import's snapshot and only counts backups taken since", async () => {
    m.initialFindMany.mockResolvedValue([pending({ reason: "import" })]);
    m.runBackup.mockResolvedValue([{ outcome: "success" }]);

    await Promise.all(await start());

    expect(m.runBackup.mock.calls[0][1].trigger).toBe("import");
  });

  it("finishes without running when a backup already landed", async () => {
    m.initialFindMany.mockResolvedValue([pending()]);
    m.backupsFindFirst.mockResolvedValueOnce({ id: "b1" });

    expect(await start()).toHaveLength(0);
    expect(m.runBackup).not.toHaveBeenCalled();
    expect(m.updates[0]).toMatchObject({ outcome: "covered", finishedAt: NOW });
  });

  it("waits for an app that crashed since the window opened", async () => {
    m.initialFindMany.mockResolvedValue([pending()]);
    m.selfHealFindMany.mockResolvedValue([{ restarts: [NOW.getTime() - MIN], gaveUpAt: null }]);

    expect(await start()).toHaveLength(0);
    expect(m.updates[0]).toEqual({ dueAt: later(HEALTHY_WINDOW_MS), armedAt: NOW });
  });

  it("leaves a job the scheduler already queued for a later tick", async () => {
    m.initialFindMany.mockResolvedValue([pending()]);
    expect(await start(new Set(["job1"]))).toHaveLength(0);
    expect(m.updates).toHaveLength(0);
  });

  it("skips a row another instance holds this minute", async () => {
    m.initialFindMany.mockResolvedValue([pending()]);
    m.acquireLock.mockResolvedValue(false);
    expect(await start()).toHaveLength(0);
    expect(m.appsFindFirst).not.toHaveBeenCalled();
  });
});
