// A deleted app's backups stay reachable by its org: downloadable, not
// restorable, and never visible to another org (#867).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { backupsFindFirst, restoreBackupMock, downloadUrlMock } = vi.hoisted(() => ({
  backupsFindFirst: vi.fn(),
  restoreBackupMock: vi.fn(),
  downloadUrlMock: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: vi.fn().mockResolvedValue({ id: "org-1" }),
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/db", () => ({ db: { query: { backups: { findFirst: backupsFindFirst } } } }));
vi.mock("@/lib/backups/engine", () => ({
  APP_DELETED_RESTORE_ERROR: "The app this backup belongs to was deleted. Download the archive instead.",
  restoreBackup: restoreBackupMock,
  getBackupDownloadUrl: downloadUrlMock,
  downloadBackupToTemp: vi.fn(),
}));

const { ArchiveMissingError } = await import("@/lib/backups/storage-port");
const { GET: download } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/history/[backupId]/download/route"
);
const { POST: restore } = await import(
  "@/app/api/v1/organizations/[orgId]/backups/history/[backupId]/restore/route"
);

const orphan = {
  id: "b-1",
  appId: "app-gone",
  appName: "web",
  organizationId: "org-1",
  status: "success",
  storagePath: "web/data.tar.gz",
  volumeName: "data",
  startedAt: new Date("2026-01-01"),
  app: null,
};

function ctx(orgId = "org-1") {
  return { params: Promise.resolve({ orgId, backupId: "b-1" }) };
}

function req(method = "GET") {
  return new NextRequest("http://localhost/api", { method });
}

/** The lookup's WHERE, rendered so the scoping can be asserted. */
function lookupWhere() {
  const where = backupsFindFirst.mock.calls[0][0].where as SQL;
  return new PgDialect().sqlToQuery(where);
}

beforeEach(() => {
  backupsFindFirst.mockReset();
  restoreBackupMock.mockReset();
  downloadUrlMock.mockReset().mockResolvedValue("https://s3.example/signed");
});

describe("a deleted app's backup", () => {
  it("downloads for its org", async () => {
    backupsFindFirst.mockResolvedValue(orphan);

    const res = await download(req(), ctx());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://s3.example/signed");
  });

  it("is looked up by the org on the backup row, not the app", async () => {
    backupsFindFirst.mockResolvedValue(orphan);

    await download(req(), ctx("org-1"));

    const { sql, params } = lookupWhere();
    expect(sql).toContain('"backup"."organization_id" = $');
    expect(sql).toContain('"backup"."app_id" is not null');
    expect(params).toContain("org-1");
  });

  it("refuses restore with a pointer to download", async () => {
    backupsFindFirst.mockResolvedValue(orphan);

    const res = await restore(req("POST"), ctx());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Download the archive/);
    expect(restoreBackupMock).not.toHaveBeenCalled();
  });
});

describe("a backup whose archive is missing", () => {
  it("downloads as a 404 that says so", async () => {
    backupsFindFirst.mockResolvedValue(orphan);
    downloadUrlMock.mockRejectedValue(new ArchiveMissingError());

    const res = await download(req(), ctx());

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("This backup's archive is missing from storage");
  });
});

describe("a live app's backup", () => {
  it("is hidden from an org the app no longer belongs to", async () => {
    backupsFindFirst.mockResolvedValue({
      ...orphan,
      app: { id: "app-1", name: "web", organizationId: "org-2" },
    });

    const res = await download(req(), ctx("org-1"));

    expect(res.status).toBe(404);
  });

  it("still restores", async () => {
    backupsFindFirst.mockResolvedValue({
      ...orphan,
      app: { id: "app-1", name: "web", organizationId: "org-1" },
    });
    restoreBackupMock.mockResolvedValue({ success: true, log: "" });

    const res = await restore(req("POST"), ctx());

    expect(res.status).toBe(200);
    expect(restoreBackupMock).toHaveBeenCalledWith("b-1");
  });
});
