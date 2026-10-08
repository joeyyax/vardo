// A deleted app's backups stay reachable by its org: downloadable, not
// restorable, and never visible to another org (#867).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { restoreBackupMock, downloadUrlMock } = vi.hoisted(() => ({
  restoreBackupMock: vi.fn(),
  downloadUrlMock: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: vi.fn().mockResolvedValue({ id: "org-1", session: { user: { id: "u1" } } }),
}));
const recordActivity = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/activity", () => ({ recordActivity }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/rate-limit", async () => (await import("@/tests/helpers/mocks")).rateLimitModule());
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
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
  const where = (dbMock.query.backups.findFirst.mock.calls[0][0] as { where: SQL }).where;
  return new PgDialect().sqlToQuery(where);
}

beforeEach(() => {
  dbMock.reset();
  dbMock.query.backups.findFirst.mockReset();
  recordActivity.mockClear();
  restoreBackupMock.mockReset();
  downloadUrlMock.mockReset().mockResolvedValue("https://s3.example/signed");
});

describe("a deleted app's backup", () => {
  it("downloads for its org", async () => {
    dbMock.query.backups.findFirst.mockResolvedValue(orphan);

    const res = await download(req(), ctx());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://s3.example/signed");
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "backup.downloaded", userId: "u1", organizationId: "org-1" }),
    );
  });

  it("is looked up by the org on the backup row, not the app", async () => {
    dbMock.query.backups.findFirst.mockResolvedValue(orphan);

    await download(req(), ctx("org-1"));

    const { sql, params } = lookupWhere();
    expect(sql).toContain('"backup"."organization_id" = $');
    expect(sql).toContain('"backup"."app_id" is not null');
    expect(params).toContain("org-1");
  });

  it("refuses restore with a pointer to download", async () => {
    dbMock.query.backups.findFirst.mockResolvedValue(orphan);

    const res = await restore(req("POST"), ctx());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Download the archive/);
    expect(restoreBackupMock).not.toHaveBeenCalled();
  });
});

describe("a backup whose archive is missing", () => {
  it("downloads as a 404 that says so", async () => {
    dbMock.query.backups.findFirst.mockResolvedValue(orphan);
    downloadUrlMock.mockRejectedValue(new ArchiveMissingError());

    const res = await download(req(), ctx());

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("This backup's archive is missing from storage");
  });
});

describe("a live app's backup", () => {
  it("is hidden from an org the app no longer belongs to", async () => {
    dbMock.query.backups.findFirst.mockResolvedValue({
      ...orphan,
      app: { id: "app-1", name: "web", organizationId: "org-2" },
    });

    const res = await download(req(), ctx("org-1"));

    expect(res.status).toBe(404);
  });

  it("is found by the org the app was transferred to", async () => {
    dbMock.query.backups.findFirst.mockResolvedValue({
      ...orphan,
      organizationId: "org-1",
      app: { id: "app-1", name: "web", organizationId: "org-2" },
    });

    const res = await download(req(), ctx("org-2"));

    expect(res.status).toBe(307);
    const { sql } = lookupWhere();
    expect(sql).toContain(
      '"backup"."app_id" in (select "id" from "app" where "organization_id" = $',
    );
  });

  it("still restores", async () => {
    dbMock.query.backups.findFirst.mockResolvedValue({
      ...orphan,
      app: { id: "app-1", name: "web", organizationId: "org-1" },
    });
    restoreBackupMock.mockResolvedValue({ success: true, log: "" });

    const res = await restore(req("POST"), ctx());

    expect(res.status).toBe(200);
    expect(restoreBackupMock).toHaveBeenCalledWith("b-1");
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "backup.restore_started", appId: "app-1", userId: "u1" }),
    );
  });
});
