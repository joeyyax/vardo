import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_FLUSH_MS,
  flushDeadline,
  needsAttention,
  opensBatch,
  shouldFlush,
  summarizeBatch,
  volumeKey,
  type BackupBatchItem,
} from "@/lib/backups/batch-rules";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/notifications/preferences", () => ({
  readOrgNotificationSettings: vi.fn(async () => ({ categories: { backups: true, host: true, apps: true }, batchWindowMinutes: 30 })),
}));

import { dbMock } from "@/tests/helpers/db";
const { recordBackupResults } = await import("@/lib/backups/batch");

const MIN = 60_000;
const t0 = Date.parse("2026-10-09T03:00:00Z");

function item(over: Partial<BackupBatchItem> = {}): BackupBatchItem {
  return {
    kind: "backup",
    appId: "a1",
    appName: "Shop",
    volumeName: "data",
    outcome: "success",
    sizeBytes: 1000,
    durationMs: 1000,
    at: new Date(t0).toISOString(),
    ...over,
  };
}

describe("flushDeadline", () => {
  it("is the window after the first result", () => {
    expect(flushDeadline(t0, 30 * MIN, null)).toBe(t0 + 30 * MIN);
  });

  it("pulls in to five minutes after a failure", () => {
    expect(flushDeadline(t0, 30 * MIN, t0 + 2 * MIN)).toBe(t0 + 2 * MIN + FAILURE_FLUSH_MS);
  });

  it("never pushes past the window for a late failure", () => {
    expect(flushDeadline(t0, 30 * MIN, t0 + 28 * MIN)).toBe(t0 + 30 * MIN);
  });
});

describe("shouldFlush", () => {
  const flushAt = t0 + 30 * MIN;

  it("waits while a job is still running", () => {
    expect(shouldFlush(flushAt, t0 + 5 * MIN, { running: true, nextScheduledAt: null })).toBe(false);
  });

  it("waits for a job scheduled inside the window", () => {
    expect(shouldFlush(flushAt, t0 + 5 * MIN, { running: false, nextScheduledAt: t0 + 15 * MIN })).toBe(false);
  });

  it("sends once everything due in the window has finished", () => {
    expect(shouldFlush(flushAt, t0 + 5 * MIN, { running: false, nextScheduledAt: t0 + 45 * MIN })).toBe(true);
    expect(shouldFlush(flushAt, t0 + 5 * MIN, { running: false, nextScheduledAt: null })).toBe(true);
  });

  it("sends at the deadline even with work still running", () => {
    expect(shouldFlush(flushAt, flushAt, { running: true, nextScheduledAt: t0 + 31 * MIN })).toBe(true);
  });
});

describe("opensBatch", () => {
  it("lets a passing drill ride along but not start a batch", () => {
    expect(opensBatch({ kind: "drill", outcome: "success" })).toBe(false);
    expect(opensBatch({ kind: "drill", outcome: "failed" })).toBe(true);
    expect(opensBatch({ kind: "restore", outcome: "success" })).toBe(true);
  });
});

describe("summarizeBatch", () => {
  it("keeps one row per app and volume, the latest result winning", () => {
    const rows = summarizeBatch(
      [item({ outcome: "failed", error: "boom", at: "2026-10-09T03:00:00Z" }), item({ at: "2026-10-09T04:00:00Z", sizeBytes: 900 })],
      new Map(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "success", sizeBytes: 900, runs: 2 });
  });

  it("puts failures first, then shrunk backups, then the rest by app", () => {
    const history = new Map([[volumeKey("a2", "db"), [1000, 1000, 1000]]]);
    const rows = summarizeBatch(
      [
        item({ appId: "a3", appName: "Apple", volumeName: "x" }),
        item({ appId: "a2", appName: "Zed", volumeName: "db", sizeBytes: 100 }),
        item({ appId: "a1", appName: "Mid", volumeName: "y", outcome: "failed" }),
      ],
      history,
    );
    expect(rows.map((r) => r.appName)).toEqual(["Mid", "Zed", "Apple"]);
    expect(rows[1].shrunk?.drop).toBeCloseTo(0.9);
    expect(rows[1].previousSize).toBe(1000);
  });

  it("needs a look for failures, shrinks and stale volumes only", () => {
    expect(needsAttention(summarizeBatch([item()], new Map()), 0)).toBe(false);
    expect(needsAttention(summarizeBatch([item()], new Map()), 1)).toBe(true);
    expect(needsAttention(summarizeBatch([item({ outcome: "failed" })], new Map()), 0)).toBe(true);
  });
});

describe("recordBackupResults", () => {
  beforeEach(() => dbMock.reset());

  it("appends to the open batch and pulls its deadline in on a failure", async () => {
    dbMock.query.backupBatches.findFirst.mockResolvedValue({ id: "b1", flushAt: new Date(t0 + 30 * MIN) });
    dbMock.updateReturns([{ id: "b1" }]);
    await recordBackupResults("org1", [item({ outcome: "failed" })], t0 + 2 * MIN);
    expect(dbMock.inserts).toHaveLength(0);
    expect((dbMock.updates[0].set as { flushAt: Date }).flushAt.getTime()).toBe(t0 + 2 * MIN + FAILURE_FLUSH_MS);
  });

  it("opens a batch when none is open", async () => {
    dbMock.query.backupBatches.findFirst.mockResolvedValue(undefined);
    dbMock.insertReturns([{ id: "new" }]);
    await recordBackupResults("org1", [item()], t0);
    const values = dbMock.inserts[0].values as { flushAt: Date; openedAt: Date };
    expect(values.openedAt.getTime()).toBe(t0);
    expect(values.flushAt.getTime()).toBe(t0 + 30 * MIN);
  });

  it("drops a passing drill when no batch is open", async () => {
    dbMock.query.backupBatches.findFirst.mockResolvedValue(undefined);
    await recordBackupResults("org1", [item({ kind: "drill" })], t0);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("retries into a new batch when the open one flushed underneath it", async () => {
    dbMock.query.backupBatches.findFirst.mockResolvedValueOnce({ id: "b1", flushAt: new Date(t0) }).mockResolvedValueOnce(undefined);
    dbMock.updateReturns([]);
    dbMock.insertReturns([{ id: "b2" }]);
    await recordBackupResults("org1", [item()], t0);
    expect(dbMock.updates).toHaveLength(1);
    expect(dbMock.inserts).toHaveLength(1);
  });
});
