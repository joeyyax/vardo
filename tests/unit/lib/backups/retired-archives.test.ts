import { describe, it, expect, vi, beforeEach } from "vitest";

// Only a retired archive whose job has a successful .age backup of the same volume is deletable.

const h = vi.hoisted(() => ({ rows: [] as unknown[], replaced: [] as unknown[] }));

const chain = (result: () => unknown[]) => ({ from: () => ({ where: async () => result() }) });
vi.mock("@/lib/db", () => ({
  db: { select: () => chain(() => h.rows), selectDistinct: () => chain(() => h.replaced) },
}));

import { findRetiredArchives } from "@/lib/backups/retired-archives";

const retired = (id: string, jobId: string | null, volumeName: string, sizeBytes = 5) => ({
  id,
  targetId: "t1",
  status: "success",
  storagePath: `${id}.enc`,
  jobId,
  jobName: "Auto: app",
  volumeName,
  sizeBytes,
});

beforeEach(() => {
  h.rows = [];
  h.replaced = [];
});

describe("findRetiredArchives", () => {
  it("deletes a volume's archives once the job has an .age backup of it", async () => {
    h.rows = [retired("a", "j1", "data"), retired("b", "j1", "data")];
    h.replaced = [{ jobId: "j1", volumeName: "data" }];
    const { jobs, deletable } = await findRetiredArchives();
    expect(deletable.map((d) => d.id)).toEqual(["a", "b"]);
    expect(jobs).toEqual([{ jobId: "j1", jobName: "Auto: app", volumeName: "data", archives: 2, bytes: 10, replaced: true }]);
  });

  it("keeps another volume of the same job that has no .age backup", async () => {
    h.rows = [retired("a", "j1", "data"), retired("b", "j1", "uploads")];
    h.replaced = [{ jobId: "j1", volumeName: "data" }];
    const { jobs, deletable } = await findRetiredArchives();
    expect(deletable.map((d) => d.id)).toEqual(["a"]);
    expect(jobs.find((j) => j.volumeName === "uploads")?.replaced).toBe(false);
  });

  it("keeps archives whose job was deleted", async () => {
    h.rows = [retired("a", null, "data")];
    const { jobs, deletable } = await findRetiredArchives();
    expect(deletable).toEqual([]);
    expect(jobs[0]).toMatchObject({ jobId: null, replaced: false });
  });

  it("deletes every retired archive with includeUnreplaced", async () => {
    h.rows = [retired("a", null, "data"), retired("b", "j1", "uploads")];
    const { jobs, deletable } = await findRetiredArchives({ includeUnreplaced: true });
    expect(deletable.map((d) => d.id)).toEqual(["a", "b"]);
    expect(jobs.every((j) => !j.replaced)).toBe(true);
  });
});
