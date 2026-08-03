// POST /api/v1/organizations/[orgId]/apps/[appId]/backup-now
//
// The endpoint reuses whatever backup job already covers the app. That job may
// cover sibling apps too, and an unscoped run backed all of them up — a backup
// of one app quietly tarring another. The run must be scoped to the app asked for.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyOrgAccess,
  mockRequirePlugin,
  mockRunBackup,
  mockEnsureAutoBackupJob,
  mockResolveBackupTarget,
  appsFindFirst,
  volumesFindMany,
  backupJobAppsFindFirst,
  backupJobsFindFirst,
  backupsFindFirst,
} = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockRequirePlugin: vi.fn(),
  mockRunBackup: vi.fn(),
  mockEnsureAutoBackupJob: vi.fn(),
  mockResolveBackupTarget: vi.fn(),
  appsFindFirst: vi.fn(),
  volumesFindMany: vi.fn(),
  backupJobAppsFindFirst: vi.fn(),
  backupJobsFindFirst: vi.fn(),
  backupsFindFirst: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: mockRequirePlugin }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
// Only runBackup is stubbed — the route shares STALE_RUN_MS with the scheduler.
vi.mock("@/lib/backups/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backups/engine")>()),
  runBackup: mockRunBackup,
}));
vi.mock("@/lib/backups/auto-backup", () => ({
  ensureAutoBackupJob: mockEnsureAutoBackupJob,
  resolveBackupTarget: mockResolveBackupTarget,
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: appsFindFirst },
      volumes: { findMany: volumesFindMany },
      backupJobApps: { findFirst: backupJobAppsFindFirst },
      backupJobs: { findFirst: backupJobsFindFirst },
      backups: { findFirst: backupsFindFirst },
    },
  },
}));

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
  vi.clearAllMocks();
  mockRequirePlugin.mockResolvedValue(null);
  mockVerifyOrgAccess.mockResolvedValue({ organization: { id: ORG_ID } });
  appsFindFirst.mockResolvedValue({ id: APP_ID, name: "app-a", displayName: "App A", source: "git" });
  volumesFindMany.mockResolvedValue([{ type: "named", persistent: true }]);
  mockResolveBackupTarget.mockResolvedValue({ id: "tgt-1" });
  // Already covered by a job that also holds a sibling app.
  mockEnsureAutoBackupJob.mockResolvedValue(null);
  backupJobAppsFindFirst.mockResolvedValue({ backupJobId: "job-1", appId: APP_ID });
  backupJobsFindFirst.mockResolvedValue({ id: "job-1", name: "Auto: app-a" });
  backupsFindFirst.mockResolvedValue(undefined);
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
    volumesFindMany.mockResolvedValue([{ type: "bind", persistent: true }]);

    const res = await POST(request(), params);

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: "BIND_MOUNTS_ONLY" });
    expect(mockRunBackup).not.toHaveBeenCalled();
  });
});
