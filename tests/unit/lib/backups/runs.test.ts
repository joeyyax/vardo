import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  estimateRunMs,
  failureSubject,
  MAX_DEADLINE_MS,
  MIN_DEADLINE_MS,
  needsAttention,
  nightlyCron,
  nightlyRunKey,
  runDeadline,
  runIsDone,
  summarizeResults,
  unfinishedJobs,
  volumeKey,
  type BackupResultItem,
  type BackupRunPlan,
} from "@/lib/backups/run-rules";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const mocks = vi.hoisted(() => ({ emit: vi.fn(), fire: vi.fn(), settle: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: mocks.emit }));
vi.mock("@/lib/notifications/observations", () => ({ fireAlert: mocks.fire, settleAlerts: mocks.settle }));
vi.mock("@/lib/notifications/preferences", () => ({ readOrgNotificationSettings: mocks.settings }));

import { dbMock } from "@/tests/helpers/db";
const { describeTarget, finishBackupRuns, recordBackupResults } = await import("@/lib/backups/runs");

const MIN = 60_000;
const t0 = Date.parse("2026-10-10T02:00:00Z");

function item(over: Partial<BackupResultItem> = {}): BackupResultItem {
  return {
    kind: "backup",
    appId: "a1",
    appName: "Shop",
    volumeName: "data",
    jobId: "j1",
    jobName: "Auto: Shop",
    outcome: "success",
    sizeBytes: 1000,
    durationMs: 1000,
    at: new Date(t0).toISOString(),
    ...over,
  };
}

const plan = (jobIds: string[]): BackupRunPlan => ({
  jobs: jobIds.map((jobId) => ({ jobId, jobName: `Auto: ${jobId}` })),
  apps: [{ appId: "a1", appName: "Shop", volumes: ["data"] }],
  target: null,
});

describe("nightly schedule", () => {
  it("starts only in its minute, once per UTC day", () => {
    expect(nightlyRunKey("02:00", new Date("2026-10-10T02:00:30Z"))).toBe("nightly:2026-10-10");
    expect(nightlyRunKey("02:00", new Date("2026-10-10T02:01:00Z"))).toBeNull();
    expect(nightlyRunKey("bad", new Date("2026-10-10T02:00:00Z"))).toBeNull();
  });

  it("mirrors the time as the jobs' cron", () => {
    expect(nightlyCron("02:30")).toBe("30 2 * * *");
    expect(nightlyCron("garbage")).toBe("0 2 * * *");
  });
});

describe("estimates and deadlines", () => {
  it("spreads recent durations over the concurrency, never under the slowest volume", () => {
    expect(estimateRunMs([10 * MIN, 10 * MIN, 10 * MIN, 10 * MIN], 2)).toBe(20 * MIN);
    expect(estimateRunMs([40 * MIN, MIN], 4)).toBe(40 * MIN);
    expect(estimateRunMs([], 4)).toBeNull();
  });

  it("gives three times the estimate, within one to six hours", () => {
    expect(runDeadline(t0, 30 * MIN)).toBe(t0 + 90 * MIN);
    expect(runDeadline(t0, MIN)).toBe(t0 + MIN_DEADLINE_MS);
    expect(runDeadline(t0, 5 * 60 * MIN)).toBe(t0 + MAX_DEADLINE_MS);
    expect(runDeadline(t0, null)).toBe(t0 + MAX_DEADLINE_MS);
  });

  it("is done once every planned job reported, or at the deadline", () => {
    const run = { plan: plan(["j1", "j2"]), jobsDone: ["j1"], deadlineAt: t0 + 60 * MIN };
    expect(runIsDone(run, t0 + MIN)).toBe(false);
    expect(runIsDone({ ...run, jobsDone: ["j1", "j2"] }, t0 + MIN)).toBe(true);
    expect(runIsDone(run, t0 + 60 * MIN)).toBe(true);
    expect(unfinishedJobs(run)).toEqual(["Auto: j2"]);
  });
});

describe("summarizeResults", () => {
  it("keeps one row per app and volume, failures then shrunk first", () => {
    const history = new Map([[volumeKey("a2", "db"), [1000, 1000, 1000]]]);
    const rows = summarizeResults(
      [
        item({ appId: "a3", appName: "Apple", volumeName: "x" }),
        item({ appId: "a2", appName: "Zed", volumeName: "db", sizeBytes: 100 }),
        item({ appId: "a1", appName: "Mid", volumeName: "y", outcome: "failed" }),
        item({ appId: "a3", appName: "Apple", volumeName: "x", at: new Date(t0 + MIN).toISOString() }),
      ],
      history,
    );
    expect(rows.map((r) => r.appName)).toEqual(["Mid", "Zed", "Apple"]);
    expect(rows[1].shrunk?.drop).toBeCloseTo(0.9);
    expect(rows[2].runs).toBe(2);
  });

  it("needs a look for failures, shrinks, stale volumes and unfinished jobs", () => {
    const ok = summarizeResults([item()], new Map());
    expect(needsAttention(ok, 0)).toBe(false);
    expect(needsAttention(ok, 0, 1)).toBe(true);
    expect(needsAttention(ok, 1)).toBe(true);
  });

  it("keys a failure by kind, app and volume", () => {
    expect(failureSubject(item({ kind: "drill" }))).toBe("drill:a1:data");
  });
});

describe("describeTarget", () => {
  it("names the bucket and prefix, never credentials", () => {
    const text = describeTarget({ name: "System default", type: "r2", config: { bucket: "vardo-backups", prefix: "/node-a/", accessKeyId: "AKIA", secretAccessKey: "s" } });
    expect(text).toBe("System default · R2 vardo-backups/node-a");
  });
});

describe("recordBackupResults", () => {
  beforeEach(() => {
    dbMock.reset();
    vi.clearAllMocks();
  });

  it("emails each failure now and clears the ones that succeeded", async () => {
    await recordBackupResults("org1", [item({ outcome: "failed", error: "boom" }), item({ volumeName: "other" })], { runId: "r1" }, t0);
    expect(mocks.fire).toHaveBeenCalledTimes(1);
    expect(mocks.fire.mock.calls[0][1]).toBe("backup.failure");
    expect(mocks.fire.mock.calls[0][2]).toMatchObject({ about: "backup:a1:data", title: "Backup of Shop / data failed" });
    expect(mocks.settle).toHaveBeenCalledWith("org1", "backup.failure", ["backup:a1:other"], new Date(t0));
    expect(dbMock.updates).toHaveLength(1);
  });

  it("folds a result outside any run into the org's open run", async () => {
    dbMock.query.backupRuns.findFirst.mockResolvedValue({ id: "open" });
    await recordBackupResults("org1", [item()], {}, t0);
    expect(dbMock.updates).toHaveLength(1);
  });

  it("drops a success when no run is open; the digest still counts it", async () => {
    dbMock.query.backupRuns.findFirst.mockResolvedValue(undefined);
    await recordBackupResults("org1", [item()], {}, t0);
    expect(dbMock.updates).toHaveLength(0);
  });
});

describe("finishBackupRuns", () => {
  beforeEach(() => {
    dbMock.reset();
    vi.clearAllMocks();
    mocks.settings.mockResolvedValue({ categories: { backups: true, backupStarts: true, host: true, apps: true }, nightlyBackupTime: "02:00" });
  });

  it("waits while a planned job hasn't reported", async () => {
    dbMock.query.backupRuns.findMany.mockResolvedValue([
      { id: "r1", organizationId: "org1", plan: plan(["j1", "j2"]), jobsDone: ["j1"], deadlineAt: new Date(t0 + 60 * MIN), startedAt: new Date(t0) },
    ]);
    await finishBackupRuns(t0 + 10 * MIN);
    expect(dbMock.updates).toHaveLength(0);
  });

  it("claims a finished run once before summarizing it", async () => {
    dbMock.query.backupRuns.findMany.mockResolvedValue([
      { id: "r1", organizationId: "org1", plan: plan(["j1"]), jobsDone: ["j1"], deadlineAt: new Date(t0 + 60 * MIN), startedAt: new Date(t0) },
    ]);
    dbMock.updateReturns([]);
    await finishBackupRuns(t0 + 10 * MIN);
    expect(dbMock.updates).toHaveLength(1);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
