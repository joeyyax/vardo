import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminContext, captureTools, plainContext, selectChain, toolBody } from "@/tests/helpers/mcp-tools";

// vardo_list_backup_jobs, vardo_list_backups and vardo_run_backup stay inside the token's orgs and never return storage details.

const h = vi.hoisted(() => ({
  instanceAdmin: vi.fn(async () => false),
  featureOn: vi.fn(async () => true),
  reachable: ["org-1"] as string[],
  canAccessOrg: vi.fn(),
  jobsFindMany: vi.fn(),
  jobFindFirst: vi.fn(),
  select: vi.fn(),
  systemJob: vi.fn(),
  runBackup: vi.fn(),
}));

vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: h.instanceAdmin }));
vi.mock("@/lib/db", () => ({
  db: { select: h.select, query: { backupJobs: { findMany: h.jobsFindMany, findFirst: h.jobFindFirst } } },
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: h.featureOn }));
vi.mock("@/lib/mcp/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/mcp/scope")>()),
  accessibleOrgIds: async () => h.reachable,
  canAccessOrg: h.canAccessOrg,
  orgLabels: async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: `Org ${id}`, slug: id }])),
}));
vi.mock("@/lib/time-zone-settings", () => ({ getOrgTimeZone: async () => "UTC" }));
vi.mock("@/lib/backups/org-backup", () => ({ orgBackupScope: () => undefined }));
vi.mock("@/lib/backups/system-storage", () => ({ readSystemBackupJob: h.systemJob }));
vi.mock("@/lib/backups/engine", () => ({ MANUAL_TRIGGER: "manual", runBackup: h.runBackup, runSucceeded: (r: { outcome: string }[]) => r.every((x) => x.outcome === "success") }));

import { registerBackupStatusTools } from "@/lib/mcp/tools/backup-status";
import { registerRunBackup } from "@/lib/mcp/tools/run-backup";

const T = new Date("2026-10-13T02:00:00Z");

const listJobs = (c = plainContext) => captureTools(registerBackupStatusTools, c).get("vardo_list_backup_jobs")!;
const listBackups = (c = plainContext) => captureTools(registerBackupStatusTools, c).get("vardo_list_backups")!;
const runTool = (c = plainContext) => captureTools(registerRunBackup, c).get("vardo_run_backup")!;

const job = {
  id: "j1",
  name: "Nightly",
  schedule: "0 2 * * *",
  enabled: true,
  nightly: false,
  lastRunAt: T,
  target: { name: "R2", type: "r2", config: { secretAccessKey: "topsecret" } },
  backupJobApps: [{ app: { id: "a1", name: "web", displayName: "Web" } }],
  backups: [
    { status: "failed", startedAt: T },
    { status: "success", startedAt: new Date(T.getTime() - 86_400_000) },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.instanceAdmin.mockResolvedValue(false);
  h.featureOn.mockResolvedValue(true);
  h.reachable = ["org-1"];
  h.canAccessOrg.mockResolvedValue(true);
  h.jobsFindMany.mockResolvedValue([job]);
  h.systemJob.mockResolvedValue({
    job: { id: "sys", name: "Vardo database", schedule: "0 3 * * *", enabled: true, lastRunAt: T, target: { name: "S3", type: "s3" } },
    history: [{ status: "success", startedAt: T, encrypted: true }],
  });
});

describe("vardo_list_backup_jobs", () => {
  it("fails while the backups feature is off", async () => {
    h.featureOn.mockResolvedValue(false);
    const res = await listJobs()({ limit: 20 });
    expect(res.isError).toBe(true);
    expect(h.jobsFindMany).not.toHaveBeenCalled();
  });

  it("lists jobs with target, last run and next run, without target config", async () => {
    const res = await listJobs()({ limit: 20 });
    const body = toolBody(res);
    expect(res.content[0].text).not.toContain("topsecret");
    expect(body.organizations[0].jobs[0]).toMatchObject({
      id: "j1",
      schedule: "0 2 * * *",
      timeZone: "UTC",
      target: { name: "R2", type: "r2" },
      appCount: 1,
      lastRun: { status: "failed", at: T.toISOString() },
      failuresInLast10: 1,
    });
    expect(Date.parse(body.organizations[0].jobs[0].nextRunAt)).toBeGreaterThan(Date.now());
    expect(body.systemDatabaseJob).toBeUndefined();
    expect(h.systemJob).not.toHaveBeenCalled();
  });

  it("gives no next run for a disabled job", async () => {
    h.jobsFindMany.mockResolvedValue([{ ...job, enabled: false }]);
    const body = toolBody(await listJobs()({ limit: 20 }));
    expect(body.organizations[0].jobs[0].nextRunAt).toBeNull();
  });

  it("adds the system database job for a live admin only", async () => {
    expect(toolBody(await listJobs(adminContext)({ limit: 20 })).systemDatabaseJob).toBeUndefined();
    h.instanceAdmin.mockResolvedValue(true);
    const body = toolBody(await listJobs(adminContext)({ limit: 20 }));
    expect(body.systemDatabaseJob).toMatchObject({ id: "sys", target: { name: "S3", type: "s3" }, lastRun: { status: "success", encrypted: true } });
  });

  it("refuses an organization the token can't reach", async () => {
    const res = await listJobs()({ organizationId: "org-2", limit: 20 });
    expect(res.isError).toBe(true);
    expect(h.jobsFindMany).not.toHaveBeenCalled();
  });
});

describe("vardo_list_backups", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "b1", jobId: "j1", jobName: "Nightly", appId: "a1", appName: "web", volumeName: "data", status: "failed", sizeBytes: null,
    trigger: null, encrypted: false, verifiedAt: null, verifyOutcome: null, startedAt: T, finishedAt: T,
    logTail: "step 1\nupload failed\n", ...over,
  });

  it("returns history with the last failure line and no storage fields", async () => {
    h.select.mockReturnValue(selectChain([row()]));
    const res = await listBackups()({ limit: 20 });
    const body = toolBody(res);
    expect(body.backups[0]).toMatchObject({ id: "b1", status: "failed", error: "upload failed", startedAt: T.toISOString() });
    expect(body.backups[0]).not.toHaveProperty("storagePath");
    expect(body.backups[0]).not.toHaveProperty("logTail");
  });

  it("reaches no backups for a token with no reachable org", async () => {
    h.reachable = [];
    const res = await listBackups()({ limit: 20 });
    expect(toolBody(res).backups).toEqual([]);
    expect(h.select).not.toHaveBeenCalled();
  });

  it("clamps the limit", async () => {
    const limits: number[] = [];
    h.select.mockReturnValue(selectChain([], { limit: limits }));
    await listBackups()({ limit: 9999 });
    expect(limits).toEqual([100]);
  });

  it("fails while the backups feature is off", async () => {
    h.featureOn.mockResolvedValue(false);
    expect((await listBackups()({ limit: 20 })).isError).toBe(true);
  });
});

describe("vardo_run_backup", () => {
  it("refuses a token without backup.run on the job's org", async () => {
    h.jobFindFirst.mockResolvedValue({ id: "j1", organizationId: "org-1" });
    h.canAccessOrg.mockResolvedValue(false);
    const res = await runTool()({ jobId: "j1" });
    expect(res.isError).toBe(true);
    expect(h.canAccessOrg).toHaveBeenCalledWith(plainContext, "org-1", "backup.run");
    expect(h.runBackup).not.toHaveBeenCalled();
  });

  it("refuses a missing job and an org-less system job", async () => {
    h.jobFindFirst.mockResolvedValue(undefined);
    expect((await runTool()({ jobId: "nope" })).isError).toBe(true);
    h.jobFindFirst.mockResolvedValue({ id: "sys", organizationId: null });
    expect((await runTool()({ jobId: "sys" })).isError).toBe(true);
    expect(h.runBackup).not.toHaveBeenCalled();
  });

  it("runs the job manually and returns each volume's outcome", async () => {
    h.jobFindFirst.mockResolvedValue({ id: "j1", organizationId: "org-1" });
    h.runBackup.mockResolvedValue([
      { backupId: "b1", appId: "a1", volumeName: "data", outcome: "success", sizeBytes: 10, storagePath: "s3://bucket/key", durationMs: 5 },
      { backupId: "b2", appId: "a1", volumeName: "uploads", outcome: "failed", sizeBytes: 0, storagePath: "", error: "boom", durationMs: 7 },
    ]);
    const res = await runTool()({ jobId: "j1" });
    expect(h.runBackup).toHaveBeenCalledWith("j1", { trigger: "manual" });
    const body = toolBody(res);
    expect(body.success).toBe(false);
    expect(body.results).toHaveLength(2);
    expect(body.results[1]).toMatchObject({ volumeName: "uploads", outcome: "failed", error: "boom" });
    expect(res.content[0].text).not.toContain("s3://bucket/key");
  });

  it("fails while the backups feature is off", async () => {
    h.featureOn.mockResolvedValue(false);
    expect((await runTool()({ jobId: "j1" })).isError).toBe(true);
    expect(h.runBackup).not.toHaveBeenCalled();
  });
});
