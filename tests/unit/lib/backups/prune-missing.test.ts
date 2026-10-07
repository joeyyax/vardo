// Retention marks a backup pruned when its archive is already gone, instead of
// retrying the delete forever (#872).

import { describe, it, expect, vi } from "vitest";

const { storageDelete, updates } = vi.hoisted(() => ({
  storageDelete: vi.fn(),
  updates: [] as unknown[],
}));

vi.mock("@/lib/backups/storage-factory", () => ({
  createBackupStorage: () => ({ delete: storageDelete }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      backupJobs: {
        findFirst: async () => ({ id: "job-1", name: "Nightly", keepLast: 1, target: {} }),
      },
      backups: {
        findMany: async () => [
          { id: "new", volumeName: "data", finishedAt: new Date("2026-02-02"), storagePath: "new.tar.gz" },
          { id: "old", volumeName: "data", finishedAt: new Date("2026-01-01"), storagePath: "old.tar.gz" },
        ],
      },
    },
    update: () => ({
      set: () => ({
        where: (where: unknown) => {
          updates.push(where);
          return Promise.resolve();
        },
      }),
    }),
  },
}));

const { pruneBackups } = await import("@/lib/backups/engine");
const { ArchiveMissingError } = await import("@/lib/backups/storage-port");

describe("pruning", () => {
  it("marks a backup pruned when its archive is already missing", async () => {
    storageDelete.mockRejectedValue(new ArchiveMissingError());

    expect(await pruneBackups("job-1")).toBe(1);
    expect(storageDelete).toHaveBeenCalledWith("old.tar.gz");
    expect(updates).toHaveLength(1);
  });
});
