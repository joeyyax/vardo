// Deleting a target never takes jobs or history silently, and a backup or a
// deleted app's history can be deleted with its archives (#872).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  role: "owner",
  targetsFindFirst: vi.fn(),
  targetsFindMany: vi.fn(),
  backupsFindFirst: vi.fn(),
  backupsFindMany: vi.fn(),
  jobsFindMany: vi.fn(),
  appsFindFirst: vi.fn(),
  stats: [] as Record<string, number>[],
  deleted: [] as string[],
  storageDelete: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: vi.fn(async () => ({ organization: { id: "org-1" }, membership: { role: h.role } })),
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/backups/storage-factory", () => ({
  createBackupStorage: () => ({ delete: h.storageDelete }),
}));
vi.mock("@/lib/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const del = (table: Parameters<typeof getTableName>[0]) => {
    h.deleted.push(getTableName(table));
    const done = Promise.resolve([{ id: "x" }]);
    return { where: () => Object.assign(done, { returning: () => done }) };
  };
  const db = {
    query: {
      backupTargets: { findFirst: h.targetsFindFirst, findMany: h.targetsFindMany },
      backups: { findFirst: h.backupsFindFirst, findMany: h.backupsFindMany },
      backupJobs: { findMany: h.jobsFindMany },
      apps: { findFirst: h.appsFindFirst },
    },
    select: () => ({ from: () => ({ where: async () => h.stats }) }),
    delete: del,
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn({ delete: del }),
  };
  return { db };
});

const { ArchiveMissingError } = await import("@/lib/backups/storage-port");
const { DELETE: deleteTarget } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/targets/[targetId]/route"
);
const { DELETE: deleteBackup } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/history/[backupId]/route"
);
const { DELETE: deleteHistory } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/history/route"
);

const target = { id: "t-1", name: "Offsite", organizationId: "org-1", type: "s3", config: {} };
const archive = {
  id: "b-1",
  targetId: "t-1",
  status: "success",
  storagePath: "org/web/data.tar.gz",
  appId: "app-gone",
  organizationId: "org-1",
  app: null,
};

function del(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: "DELETE",
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
}

const targetCtx = { params: Promise.resolve({ orgId: "org-1", targetId: "t-1" }) };
const backupCtx = { params: Promise.resolve({ orgId: "org-1", backupId: "b-1" }) };
const orgCtx = { params: Promise.resolve({ orgId: "org-1" }) };
const TARGET_URL = "http://localhost/api/v1/organizations/org-1/backups/targets/t-1";
const HISTORY_URL = "http://localhost/api/v1/organizations/org-1/backups/history";

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "owner";
  h.deleted.length = 0;
  h.stats = [{ backups: 0, bytes: 0, inProgress: 0 }];
  h.targetsFindFirst.mockResolvedValue(target);
  h.targetsFindMany.mockResolvedValue([target]);
  h.backupsFindMany.mockResolvedValue([]);
  h.backupsFindFirst.mockResolvedValue(archive);
  h.jobsFindMany.mockResolvedValue([]);
  h.appsFindFirst.mockResolvedValue(undefined);
  h.storageDelete.mockResolvedValue(undefined);
});

describe("deleting a target", () => {
  it("is for owners and admins", async () => {
    h.role = "member";

    const res = await deleteTarget(del(TARGET_URL), targetCtx);

    expect(res.status).toBe(403);
    expect(h.deleted).toEqual([]);
  });

  it("refuses while it holds backups, naming what would go", async () => {
    h.stats = [{ backups: 12, bytes: 4096, inProgress: 0 }];
    h.jobsFindMany.mockResolvedValue([
      { name: "Nightly", organizationId: "org-1" },
      { name: "Theirs", organizationId: "org-2" },
    ]);

    const res = await deleteTarget(del(TARGET_URL), targetCtx);

    expect(res.status).toBe(409);
    const { usage } = await res.json();
    expect(usage).toEqual({ backups: 12, bytes: 4096, inProgress: 0, jobs: 2, jobNames: ["Nightly"] });
    expect(h.deleted).toEqual([]);
  });

  it("refuses while jobs write to it, even with no backups yet", async () => {
    h.jobsFindMany.mockResolvedValue([{ name: "Nightly", organizationId: "org-1" }]);

    const res = await deleteTarget(del(TARGET_URL), targetCtx);

    expect(res.status).toBe(409);
    expect(h.deleted).toEqual([]);
  });

  it("refuses a confirmation that doesn't match its name", async () => {
    h.stats = [{ backups: 1, bytes: 10, inProgress: 0 }];

    const res = await deleteTarget(del(TARGET_URL, { confirm: "offsite" }), targetCtx);

    expect(res.status).toBe(409);
    expect(h.deleted).toEqual([]);
  });

  it("refuses while a backup is writing to it", async () => {
    h.stats = [{ backups: 1, bytes: 0, inProgress: 1 }];

    const res = await deleteTarget(del(TARGET_URL, { confirm: "Offsite" }), targetCtx);

    expect(res.status).toBe(409);
    expect(h.deleted).toEqual([]);
  });

  it("deletes archives, backups, jobs and the target once confirmed by name", async () => {
    h.stats = [{ backups: 2, bytes: 10, inProgress: 0 }];
    h.jobsFindMany.mockResolvedValue([{ name: "Nightly", organizationId: "org-1" }]);
    h.backupsFindMany.mockResolvedValue([
      archive,
      { ...archive, id: "b-2", storagePath: "org/web/old.tar.gz" },
    ]);
    h.storageDelete.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("timeout"));

    const res = await deleteTarget(del(TARGET_URL, { confirm: "Offsite" }), targetCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, jobs: 1, backups: 2, archivesLeft: 1 });
    expect(h.storageDelete).toHaveBeenCalledWith("org/web/data.tar.gz");
    expect(h.deleted).toEqual(["backup", "backup_job", "backup_target"]);
  });

  it("deletes an unused target without a confirmation", async () => {
    const res = await deleteTarget(del(TARGET_URL), targetCtx);

    expect(res.status).toBe(200);
    expect(h.deleted).toEqual(["backup_target"]);
  });
});

describe("deleting one backup", () => {
  it("is for owners and admins", async () => {
    h.role = "member";

    const res = await deleteBackup(del(`${HISTORY_URL}/b-1`), backupCtx);

    expect(res.status).toBe(403);
    expect(h.storageDelete).not.toHaveBeenCalled();
  });

  it("deletes the archive, then the row", async () => {
    const res = await deleteBackup(del(`${HISTORY_URL}/b-1`), backupCtx);

    expect(res.status).toBe(200);
    expect(h.storageDelete).toHaveBeenCalledWith("org/web/data.tar.gz");
    expect(h.deleted).toEqual(["backup"]);
  });

  it("deletes the row when the archive is already gone", async () => {
    h.storageDelete.mockRejectedValue(new ArchiveMissingError());

    const res = await deleteBackup(del(`${HISTORY_URL}/b-1`), backupCtx);

    expect(res.status).toBe(200);
    expect(h.deleted).toEqual(["backup"]);
  });

  it("keeps the row when storage won't delete the archive", async () => {
    h.storageDelete.mockRejectedValue(new Error("AccessDenied"));

    const res = await deleteBackup(del(`${HISTORY_URL}/b-1`), backupCtx);

    expect(res.status).toBe(502);
    expect(h.deleted).toEqual([]);
  });

  it("skips storage for a pruned backup", async () => {
    h.backupsFindFirst.mockResolvedValue({ ...archive, status: "pruned" });

    const res = await deleteBackup(del(`${HISTORY_URL}/b-1`), backupCtx);

    expect(res.status).toBe(200);
    expect(h.storageDelete).not.toHaveBeenCalled();
    expect(h.deleted).toEqual(["backup"]);
  });

  it("refuses a backup that is still running", async () => {
    h.backupsFindFirst.mockResolvedValue({ ...archive, status: "running" });

    const res = await deleteBackup(del(`${HISTORY_URL}/b-1`), backupCtx);

    expect(res.status).toBe(409);
    expect(h.deleted).toEqual([]);
  });
});

describe("deleting a deleted app's or job's history", () => {
  it("deletes every archive and row for a deleted app", async () => {
    h.backupsFindMany.mockResolvedValue([
      archive,
      { ...archive, id: "b-2", storagePath: null, status: "failed" },
    ]);

    const res = await deleteHistory(del(`${HISTORY_URL}?appId=app-gone`), orgCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2, kept: 0 });
    expect(h.storageDelete).toHaveBeenCalledTimes(1);
  });

  it("deletes a deleted job's history by its name", async () => {
    h.backupsFindMany.mockResolvedValue([archive]);

    const res = await deleteHistory(del(`${HISTORY_URL}?jobName=Nightly`), orgCtx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1, kept: 0 });
  });

  it("refuses an app that still exists", async () => {
    h.appsFindFirst.mockResolvedValue({ id: "app-1" });

    const res = await deleteHistory(del(`${HISTORY_URL}?appId=app-1`), orgCtx);

    expect(res.status).toBe(409);
    expect(h.deleted).toEqual([]);
  });

  it("is for owners and admins", async () => {
    h.role = "member";

    const res = await deleteHistory(del(`${HISTORY_URL}?appId=app-gone`), orgCtx);

    expect(res.status).toBe(403);
  });

  it("keeps rows whose archive won't delete", async () => {
    h.backupsFindMany.mockResolvedValue([archive]);
    h.storageDelete.mockRejectedValue(new Error("AccessDenied"));

    const res = await deleteHistory(del(`${HISTORY_URL}?appId=app-gone`), orgCtx);

    expect(await res.json()).toEqual({ deleted: 0, kept: 1 });
    expect(h.deleted).toEqual([]);
  });
});
