// An import holds the claim of every job covering its app, and refuses while a run of one holds it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Job claims held now, by job. */
  claims: new Map<string, string>(),
  links: [] as { backupJobId: string }[],
  trackBackupWork: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      backupJobApps: { findMany: async () => h.links },
      apps: { findFirst: async () => ({ displayName: "Shop" }) },
    },
  },
}));
vi.mock("@/lib/backups/job-claim", () => ({
  claimJob: async (jobId: string, by: string) => {
    if (h.claims.has(jobId)) return null;
    h.claims.set(jobId, by);
    return async () => {
      h.claims.delete(jobId);
    };
  },
}));
vi.mock("@/lib/backups/in-flight", () => ({ trackBackupWork: h.trackBackupWork }));
vi.mock("@/lib/backups/runs", () => ({ recordBackupResults: async () => {} }));

const { ImportError, importIntoApp } = await import("@/lib/backups/import");

const opts = { appId: "app1", organizationId: "org1", volumeName: "data", source: { type: "url" as const, url: "https://example.com/dump.sql" } };

describe("importIntoApp and the job claim", () => {
  beforeEach(() => {
    h.claims.clear();
    h.links = [{ backupJobId: "job1" }, { backupJobId: "job2" }];
    h.trackBackupWork.mockReset();
  });

  it("holds every covering job's claim for the import and releases them after", async () => {
    let during: string[] = [];
    h.trackBackupWork.mockImplementation(async () => {
      during = [...h.claims.entries()].map(([id, by]) => `${id}:${by}`);
      return { success: false, format: null, bytes: 0, log: "" };
    });

    await importIntoApp(opts);

    expect(during).toEqual(["job1:import", "job2:import"]);
    expect(h.claims.size).toBe(0);
  });

  it("refuses with a 409 while a run holds one of the jobs, keeping that run's claim", async () => {
    h.claims.set("job2", "scheduled");

    const err = await importIntoApp(opts).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImportError);
    expect(err).toMatchObject({ status: 409, message: expect.stringMatching(/backup of this app is running/) });
    expect(h.trackBackupWork).not.toHaveBeenCalled();
    expect([...h.claims.entries()]).toEqual([["job2", "scheduled"]]);
  });

  it("releases the claims when the import throws", async () => {
    h.trackBackupWork.mockRejectedValue(new ImportError("App not found", 404));

    await expect(importIntoApp(opts)).rejects.toMatchObject({ status: 404 });
    expect(h.claims.size).toBe(0);
  });
});
