import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminContext, captureTools, plainContext, toolBody } from "@/tests/helpers/mcp-tools";

// vardo_run_system_backup exists only for an admin-scoped token held by a live instance admin and never waits for the run.

const h = vi.hoisted(() => ({
  instanceAdmin: vi.fn(async () => true),
  featureOn: vi.fn(async () => true),
  findSystemJob: vi.fn(),
  runBackup: vi.fn(),
  claimJob: vi.fn(),
}));

const T = new Date("2026-10-13T03:00:00Z");

vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: h.instanceAdmin }));
vi.mock("@/lib/db", () => ({
  db: { query: { backups: { findFirst: async () => undefined }, backupJobs: { findFirst: async () => ({ id: "sys", name: "Vardo database", organizationId: null }) } } },
}));
vi.mock("@/lib/backups/job-claim", () => ({ claimJob: h.claimJob, jobClaimHolder: async () => ({ by: "scheduled", startedAt: T }) }));
vi.mock("@/lib/backups/runs", () => ({ nightlyRunStartedSince: async () => null, startManualRun: async () => null, markJobDone: async () => {} }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: h.featureOn }));
vi.mock("@/lib/backups/run-limit", () => ({ withSizedBackupSlot: (fn: () => unknown) => fn() }));
vi.mock("@/lib/backups/engine", () => ({ MANUAL_TRIGGER: "manual", STALE_RUN_MS: 3_600_000, runBackup: h.runBackup }));
vi.mock("@/lib/backups/system-storage", () => ({ findSystemJob: h.findSystemJob }));

import { registerRunSystemBackup } from "@/lib/mcp/tools/run-system-backup";

const tools = (c = adminContext) => captureTools(registerRunSystemBackup, c);
const run = (c = adminContext) => tools(c).get("vardo_run_system_backup")!;

beforeEach(() => {
  vi.clearAllMocks();
  h.instanceAdmin.mockResolvedValue(true);
  h.featureOn.mockResolvedValue(true);
  h.findSystemJob.mockResolvedValue({ id: "sys" });
  h.runBackup.mockReturnValue(new Promise(() => {}));
  h.claimJob.mockResolvedValue(async () => {});
});

describe("vardo_run_system_backup", () => {
  it("isn't registered without the admin scope", () => {
    expect(tools(plainContext).has("vardo_run_system_backup")).toBe(false);
  });

  it("refuses once the user is no longer an instance admin", async () => {
    h.instanceAdmin.mockResolvedValue(false);
    const res = await run()({});
    expect(res.isError).toBe(true);
    expect(h.runBackup).not.toHaveBeenCalled();
  });

  it("fails while the backups feature is off", async () => {
    h.featureOn.mockResolvedValue(false);
    expect((await run()({})).isError).toBe(true);
    expect(h.runBackup).not.toHaveBeenCalled();
  });

  it("fails when no system backup job exists", async () => {
    h.findSystemJob.mockResolvedValue(null);
    expect((await run()({})).isError).toBe(true);
    expect(h.runBackup).not.toHaveBeenCalled();
  });

  it("starts the system job manually without waiting for it", async () => {
    const body = toolBody(await run()({}));
    await vi.waitFor(() => expect(h.runBackup).toHaveBeenCalledWith("sys", { trigger: "manual" }));
    expect(body).toMatchObject({ status: "started", jobId: "sys" });
    expect(Date.parse(body.startedAt)).not.toBeNaN();
  });

  it("uses the system backup already in progress", async () => {
    h.claimJob.mockResolvedValue(null);
    const res = await run()({});
    expect(res.isError).toBeUndefined();
    expect(toolBody(res)).toMatchObject({ status: "in_progress", jobId: "sys", startedAt: T.toISOString() });
    expect(h.runBackup).not.toHaveBeenCalled();
  });

  it("swallows a run rejection after returning", async () => {
    h.runBackup.mockRejectedValue(new Error("boom"));
    expect(toolBody(await run()({})).status).toBe("started");
    await new Promise((r) => setTimeout(r, 0));
  });
});
