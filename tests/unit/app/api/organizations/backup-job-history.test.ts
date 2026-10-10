// Job-less history lists for its org (#871), and a retention change applies to
// a paused job without waiting for a run that never comes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { jobsFindMany, backupsFindMany, mockUpdate, pruneBackupsMock, storedRows } = vi.hoisted(() => ({
  storedRows: vi.fn(),
  jobsFindMany: vi.fn(),
  backupsFindMany: vi.fn(),
  mockUpdate: vi.fn(),
  pruneBackupsMock: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: vi.fn().mockResolvedValue({ id: "org-1", membership: { role: "owner" } }),
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/rate-limit", async () => (await import("@/tests/helpers/mocks")).rateLimitModule());
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      backupJobs: { findMany: jobsFindMany },
      backups: { findMany: backupsFindMany },
    },
    update: mockUpdate,
    select: () => ({ from: () => ({ where: () => ({ groupBy: storedRows }) }) }),
  },
}));
vi.mock("@/lib/backups/engine", () => ({ pruneBackups: pruneBackupsMock }));

const { GET: list } = await import("@/app/api/v1/organizations/[orgId]/backups/route");
const { PATCH: updateJob } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/jobs/[jobId]/route"
);

const jobless = {
  id: "b-1",
  jobId: null,
  jobName: "Auto: web",
  job: null,
  appId: "app-gone",
  appName: "web",
  app: null,
  organizationId: "org-1",
  status: "success",
  startedAt: new Date("2026-01-01"),
};

function listWhere() {
  const where = backupsFindMany.mock.calls[0][0].where as SQL;
  return new PgDialect().sqlToQuery(where);
}

beforeEach(() => {
  jobsFindMany.mockReset().mockResolvedValue([]);
  backupsFindMany.mockReset();
  storedRows.mockReset().mockResolvedValue([]);
  pruneBackupsMock.mockReset().mockResolvedValue(0);
  mockUpdate.mockReset().mockReturnValue({
    set: () => ({
      where: () => ({ returning: async () => [{ id: "job-1", enabled: false }] }),
    }),
  });
});

describe("backup history list", () => {
  it("includes history whose job was deleted", async () => {
    backupsFindMany.mockResolvedValue([jobless]);

    const res = await list(new NextRequest("http://localhost/api"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    const body = await res.json();
    expect(body.recentHistory.map((b: { id: string }) => b.id)).toEqual(["b-1"]);
  });

  it("totals the archives still in storage, per job and in all", async () => {
    backupsFindMany.mockResolvedValue([]);
    storedRows.mockResolvedValue([
      { jobId: "job-1", bytes: "300" },
      { jobId: null, bytes: "50" },
    ]);

    const res = await list(new NextRequest("http://localhost/api"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    expect((await res.json()).storedBytes).toEqual({ total: 350, byJob: { "job-1": 300 } });
  });

  it("is scoped by the org on the backup row", async () => {
    backupsFindMany.mockResolvedValue([]);

    await list(new NextRequest("http://localhost/api"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    const { sql, params } = listWhere();
    expect(sql).toContain('"backup"."organization_id" = $');
    expect(params).toEqual(["org-1", "org-1"]);
  });

  it("follows a live app into the org it was transferred to", async () => {
    backupsFindMany.mockResolvedValue([]);

    await list(new NextRequest("http://localhost/api"), {
      params: Promise.resolve({ orgId: "org-2" }),
    });

    const { sql } = listWhere();
    expect(sql).toContain(
      '"backup"."app_id" in (select "id" from "app" where "organization_id" = $1)',
    );
    expect(sql).toContain('"backup"."app_id" not in (select "id" from "app")');
  });

  it("leaves out a live app's backups once the app is in another org", async () => {
    backupsFindMany.mockResolvedValue([
      jobless,
      { ...jobless, id: "b-2", app: { id: "app-1", name: "api", displayName: "api", organizationId: "org-2" } },
    ]);

    const res = await list(new NextRequest("http://localhost/api"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });

    const body = await res.json();
    expect(body.recentHistory.map((b: { id: string }) => b.id)).toEqual(["b-1"]);
  });
});

describe("updating a job", () => {
  function patch(body: unknown) {
    return updateJob(
      new NextRequest("http://localhost/api", { method: "PATCH", body: JSON.stringify(body) }),
      { params: Promise.resolve({ orgId: "org-1", jobId: "job-1" }) },
    );
  }

  it("prunes a paused job when its retention changes", async () => {
    const res = await patch({ enabled: false, keepLast: 1 });

    expect(res.status).toBe(200);
    expect(pruneBackupsMock).toHaveBeenCalledWith("job-1");
  });

  it("leaves storage alone for a change that is not retention", async () => {
    await patch({ name: "Nightly" });

    expect(pruneBackupsMock).not.toHaveBeenCalled();
  });

  it("still saves when pruning fails", async () => {
    pruneBackupsMock.mockRejectedValue(new Error("target unreachable"));

    const res = await patch({ keepDaily: 3 });

    expect(res.status).toBe(200);
  });
});
