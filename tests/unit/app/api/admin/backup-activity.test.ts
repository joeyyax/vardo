import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Instance-admin backup restore and download leave an activity record, in the
// backup's org or, for an instance-level backup, the Vardo system org.

const h = vi.hoisted(() => ({
  backup: null as Record<string, unknown> | null,
  recordActivity: vi.fn(async () => {}),
  restoreBackup: vi.fn(async () => ({ success: true })),
}));

vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin: async () => ({ user: { id: "admin-1" } }) }));
vi.mock("@/lib/activity", () => ({ recordActivity: h.recordActivity }));
vi.mock("@/lib/infra/vardo-org", () => ({ findVardoOrgId: async () => "org-vardo" }));
vi.mock("@/lib/backups/engine", () => ({ restoreBackup: h.restoreBackup }));
vi.mock("@/lib/backups/download-response", () => ({
  backupDownloadResponse: async () => NextResponse.redirect("https://s3.example/signed"),
}));
vi.mock("@/lib/db", () => ({ db: { query: { backups: { findFirst: async () => h.backup } } } }));

const { GET: download } = await import("@/app/api/v1/admin/backups/[backupId]/download/route");
const { POST: restore } = await import("@/app/api/v1/admin/backups/[backupId]/restore/route");

const params = { params: Promise.resolve({ backupId: "b-1" }) };
const systemBackup = {
  id: "b-1",
  status: "success",
  storagePath: "s3://x",
  organizationId: null,
  appId: null,
  volumeName: "pg",
  startedAt: new Date("2026-10-01"),
};

beforeEach(() => {
  h.recordActivity.mockClear();
  h.backup = { ...systemBackup };
});

describe("instance-admin backup activity", () => {
  it("records a download in the Vardo org for an instance-level backup", async () => {
    await download(new NextRequest("http://localhost/x"), params);

    expect(h.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-vardo", action: "backup.downloaded", userId: "admin-1" }),
    );
  });

  it("records a download in the backup's own org when it has one", async () => {
    h.backup = { ...systemBackup, organizationId: "org-1", appId: "app-1" };
    await download(new NextRequest("http://localhost/x"), params);

    expect(h.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", appId: "app-1", action: "backup.downloaded" }),
    );
  });

  it("records a restore", async () => {
    await restore(new NextRequest("http://localhost/x", { method: "POST", body: "{}" }), params);

    expect(h.restoreBackup).toHaveBeenCalled();
    expect(h.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-vardo", action: "backup.restore_started" }),
    );
  });

  it("records nothing for a refused restore", async () => {
    h.backup = { ...systemBackup, status: "failed" };
    await restore(new NextRequest("http://localhost/x", { method: "POST", body: "{}" }), params);

    expect(h.recordActivity).not.toHaveBeenCalled();
  });
});
