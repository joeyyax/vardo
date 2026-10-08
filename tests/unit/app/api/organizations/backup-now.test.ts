// POST /api/v1/organizations/[orgId]/apps/[appId]/backup-now
//
// The endpoint reuses whatever backup job already covers the app. That job may
// cover sibling apps too, and an unscoped run backed all of them up — a backup
// of one app quietly tarring another. The run must be scoped to the app asked for.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { NextRequest } from "next/server";

const {
  mockVerifyOrgAccess,
  mockRequirePlugin,
  mockRunBackup,
  mockEnsureAutoBackupJob,
  mockResolveBackupTarget,
} = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockRequirePlugin: vi.fn(),
  mockRunBackup: vi.fn(),
  mockEnsureAutoBackupJob: vi.fn(),
  mockResolveBackupTarget: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: mockRequirePlugin }));
vi.mock("@/lib/api/rate-limit", async () => (await import("@/tests/helpers/mocks")).rateLimitModule());
// Only runBackup is stubbed — the route shares STALE_RUN_MS with the scheduler.
vi.mock("@/lib/backups/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backups/engine")>()),
  runBackup: mockRunBackup,
}));
vi.mock("@/lib/backups/auto-backup", () => ({
  ensureAutoBackupJob: mockEnsureAutoBackupJob,
  resolveBackupTarget: mockResolveBackupTarget,
}));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { POST } = await import(
  "@/app/api/v1/organizations/[orgId]/apps/[appId]/backup-now/route"
);

const ORG_ID = "org-1";
const APP_ID = "app-a";
const params = { params: Promise.resolve({ orgId: ORG_ID, appId: APP_ID }) };

function request() {
  return new NextRequest(
    `http://localhost/api/v1/organizations/${ORG_ID}/apps/${APP_ID}/backup-now`,
    { method: "POST" },
  );
}

beforeEach(() => {
  dbMock.reset();
  vi.clearAllMocks();
  mockRequirePlugin.mockResolvedValue(null);
  mockVerifyOrgAccess.mockResolvedValue({ organization: { id: ORG_ID } });
  dbMock.query.apps.findFirst.mockResolvedValue({ id: APP_ID, name: "app-a", displayName: "App A", source: "git" });
  dbMock.query.volumes.findMany.mockResolvedValue([{ type: "named", persistent: true }]);
  mockResolveBackupTarget.mockResolvedValue({ id: "tgt-1" });
  // Already covered by a job that also holds a sibling app.
  mockEnsureAutoBackupJob.mockResolvedValue(null);
  dbMock.query.backupJobApps.findFirst.mockResolvedValue({ backupJobId: "job-1", appId: APP_ID });
  dbMock.query.backupJobs.findFirst.mockResolvedValue({ id: "job-1", name: "Auto: app-a" });
  dbMock.query.backups.findFirst.mockResolvedValue(undefined);
  mockRunBackup.mockResolvedValue([]);
});

describe("POST /apps/[appId]/backup-now — job reuse", () => {
  it("scopes the run to the requested app", async () => {
    const res = await POST(request(), params);

    expect(res.status).toBe(202);
    expect(mockRunBackup).toHaveBeenCalledWith("job-1", { appIds: [APP_ID] });
    await expect(res.json()).resolves.toMatchObject({ jobId: "job-1", appIds: [APP_ID] });
  });

  it("rejects an app whose only persistent data is on bind mounts", async () => {
    dbMock.query.volumes.findMany.mockResolvedValue([{ type: "bind", persistent: true }]);

    const res = await POST(request(), params);

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: "BIND_MOUNTS_ONLY" });
    expect(mockRunBackup).not.toHaveBeenCalled();
  });

  it("runs an app whose bind mounts were opted in (#874)", async () => {
    dbMock.query.volumes.findMany.mockResolvedValue([
      { type: "bind", persistent: false, backupStrategy: "tar", backupSelection: "include" },
    ]);

    const res = await POST(request(), params);

    expect(res.status).toBe(202);
    expect(mockRunBackup).toHaveBeenCalledWith("job-1", { appIds: [APP_ID] });
  });
});
