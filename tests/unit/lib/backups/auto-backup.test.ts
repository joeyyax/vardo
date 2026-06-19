// #757: duplicate "Auto:" backup jobs came from ensureAutoBackupJob inserting
// the job row and its app link non-transactionally — a failed link insert left
// an orphan job the dedup-by-app-link guard couldn't see, so the next deploy
// made another. These tests pin the fix: job + link are created inside one
// transaction (a link failure aborts the whole thing), the dedup guard skips
// apps already covered, and apps without persistent volumes are skipped.

import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  volumesFindMany,
  backupJobAppsFindFirst,
  backupTargetsFindFirst,
  transactionMock,
  state,
} = vi.hoisted(() => ({
  volumesFindMany: vi.fn(),
  backupJobAppsFindFirst: vi.fn(),
  backupTargetsFindFirst: vi.fn(),
  transactionMock: vi.fn(),
  state: { inserted: [] as string[], failLinkInsert: false },
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      volumes: { findMany: volumesFindMany },
      backupJobApps: { findFirst: backupJobAppsFindFirst },
      backupTargets: { findFirst: backupTargetsFindFirst },
    },
    transaction: transactionMock,
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/system-settings", () => ({ getBackupStorageConfig: vi.fn() }));

import { backupJobs, backupJobApps } from "@/lib/db/schema";
import { ensureAutoBackupJob } from "@/lib/backups/auto-backup";

beforeEach(() => {
  state.inserted = [];
  state.failLinkInsert = false;
  volumesFindMany.mockReset();
  backupJobAppsFindFirst.mockReset();
  backupTargetsFindFirst.mockReset().mockResolvedValue({ id: "tgt-1", organizationId: "o1" });
  transactionMock.mockReset().mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const tx = {
      insert: (table: unknown) => ({
        values: async () => {
          const name =
            table === backupJobApps ? "backupJobApps" : table === backupJobs ? "backupJobs" : "other";
          if (name === "backupJobApps" && state.failLinkInsert) throw new Error("link insert failed");
          state.inserted.push(name);
        },
      }),
    };
    return cb(tx);
  });
});

describe("ensureAutoBackupJob — atomic job+link creation (#757)", () => {
  it("creates the job and its app link inside a single transaction", async () => {
    volumesFindMany.mockResolvedValue([{ persistent: true }]);
    backupJobAppsFindFirst.mockResolvedValue(undefined); // not yet covered

    const jobId = await ensureAutoBackupJob({ appId: "a1", appName: "myapp", organizationId: "o1" });

    expect(typeof jobId).toBe("string");
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(state.inserted).toEqual(["backupJobs", "backupJobApps"]);
  });

  it("rolls back (rejects) if the app-link insert fails — no orphan job", async () => {
    volumesFindMany.mockResolvedValue([{ persistent: true }]);
    backupJobAppsFindFirst.mockResolvedValue(undefined);
    state.failLinkInsert = true;

    await expect(
      ensureAutoBackupJob({ appId: "a1", appName: "myapp", organizationId: "o1" }),
    ).rejects.toThrow(/link insert failed/);
    // The whole unit of work is the transaction callback; a real DB rolls back
    // the job row when the link throws, so no orphan survives.
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it("skips apps already covered by a backup job (dedup guard)", async () => {
    volumesFindMany.mockResolvedValue([{ persistent: true }]);
    backupJobAppsFindFirst.mockResolvedValue({ backupJobId: "existing" });

    const result = await ensureAutoBackupJob({ appId: "a1", appName: "myapp", organizationId: "o1" });

    expect(result).toBeNull();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("skips apps with no persistent volumes", async () => {
    volumesFindMany.mockResolvedValue([{ persistent: false }]);

    const result = await ensureAutoBackupJob({ appId: "a1", appName: "myapp", organizationId: "o1" });

    expect(result).toBeNull();
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
