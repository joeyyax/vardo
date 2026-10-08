// #892: deleting an app deletes the "Auto: <app>" job it leaves empty; history keeps the job name.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { calls, state } = vi.hoisted(() => ({ calls: [] as string[], state: { empty: [{ id: "job-1" }] } }));

vi.mock("@/lib/db", () => ({
  db: {
    transaction: async (cb: (tx: unknown) => unknown) =>
      cb({
        select: () => ({ from: () => ({ where: async () => state.empty }) }),
        update: () => ({
          set: () => ({
            where: async () => {
              calls.push("snapshot");
            },
          }),
        }),
        delete: () => ({
          where: async () => {
            calls.push("delete");
          },
        }),
      }),
  },
}));
vi.mock("@/lib/system-settings", () => ({ getBackupStorageConfig: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { deleteEmptyAutoJobs } from "@/lib/backups/auto-backup";

beforeEach(() => {
  calls.length = 0;
  state.empty = [{ id: "job-1" }];
});

describe("deleteEmptyAutoJobs", () => {
  it("snapshots the job name onto its history, then deletes the job", async () => {
    await expect(deleteEmptyAutoJobs("org-1", ["agents"])).resolves.toEqual(["job-1"]);
    expect(calls).toEqual(["snapshot", "delete"]);
  });

  it("deletes nothing when no emptied job matches", async () => {
    state.empty = [];

    await expect(deleteEmptyAutoJobs("org-1", ["agents"])).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});
