import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminContext, captureTools, plainContext, toolBody } from "@/tests/helpers/mcp-tools";

// vardo_drill_backup needs backup.run on the backup's org, drills only successful app backups and never waits for the drill.

const h = vi.hoisted(() => ({
  instanceAdmin: vi.fn(async () => false),
  featureOn: vi.fn(async () => true),
  canAccessOrg: vi.fn(),
  backupFindFirst: vi.fn(),
  drillable: vi.fn(),
  runRestoreDrill: vi.fn(),
}));

vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: h.instanceAdmin }));
vi.mock("@/lib/db", () => ({ db: { query: { backups: { findFirst: h.backupFindFirst } } } }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: h.featureOn }));
vi.mock("@/lib/mcp/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/mcp/scope")>()),
  canAccessOrg: h.canAccessOrg,
}));
vi.mock("@/lib/backups/org-backup", async (orig) => ({
  ...(await orig<typeof import("@/lib/backups/org-backup")>()),
  findDrillableBackup: h.drillable,
}));
vi.mock("@/lib/backups/drill", () => ({ runRestoreDrill: h.runRestoreDrill }));

import { registerDrillBackup } from "@/lib/mcp/tools/drill-backup";

const drill = (c = plainContext) => captureTools(registerDrillBackup, c).get("vardo_drill_backup")!;

const appBackup = { id: "b1", appId: "a1", organizationId: "org-1", app: { organizationId: "org-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.instanceAdmin.mockResolvedValue(false);
  h.featureOn.mockResolvedValue(true);
  h.canAccessOrg.mockResolvedValue(true);
  h.backupFindFirst.mockResolvedValue(appBackup);
  h.drillable.mockResolvedValue({ ok: true, backup: appBackup });
  h.runRestoreDrill.mockReturnValue(new Promise(() => {}));
});

describe("vardo_drill_backup", () => {
  it("refuses a token without backup.run on the backup's org", async () => {
    h.canAccessOrg.mockResolvedValue(false);
    const res = await drill()({ backupId: "b1" });
    expect(res.isError).toBe(true);
    expect(h.canAccessOrg).toHaveBeenCalledWith(plainContext, "org-1", "backup.run");
    expect(h.runRestoreDrill).not.toHaveBeenCalled();
  });

  it("checks the app's org, not the row's stale one", async () => {
    h.backupFindFirst.mockResolvedValue({ ...appBackup, organizationId: "old", app: { organizationId: "org-2" } });
    await drill()({ backupId: "b1" });
    expect(h.canAccessOrg).toHaveBeenCalledWith(plainContext, "org-2", "backup.run");
  });

  it("refuses a missing backup", async () => {
    h.backupFindFirst.mockResolvedValue(undefined);
    expect((await drill()({ backupId: "nope" })).isError).toBe(true);
    expect(h.runRestoreDrill).not.toHaveBeenCalled();
  });

  it("refuses a backup that didn't succeed", async () => {
    h.drillable.mockResolvedValue({ ok: false, reason: "not_successful" });
    const res = await drill()({ backupId: "b1" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("successful");
    expect(h.runRestoreDrill).not.toHaveBeenCalled();
  });

  it("refuses a system backup with a clear message for an admin and as not found otherwise", async () => {
    h.backupFindFirst.mockResolvedValue({ id: "s1", appId: null, organizationId: null, app: null });
    expect((await drill()({ backupId: "s1" })).content[0].text).toContain("not found");
    h.instanceAdmin.mockResolvedValue(true);
    const res = await drill(adminContext)({ backupId: "s1" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("system database");
    expect(h.runRestoreDrill).not.toHaveBeenCalled();
  });

  it("fails while the backups feature is off", async () => {
    h.featureOn.mockResolvedValue(false);
    expect((await drill()({ backupId: "b1" })).isError).toBe(true);
    expect(h.runRestoreDrill).not.toHaveBeenCalled();
  });

  it("starts the drill without waiting for it", async () => {
    h.runRestoreDrill.mockReturnValue(new Promise(() => {}));
    const body = toolBody(await drill()({ backupId: "b1" }));
    expect(h.runRestoreDrill).toHaveBeenCalledWith("b1");
    expect(body).toEqual({ status: "started", backupId: "b1" });
  });

  it("swallows a drill rejection after returning", async () => {
    h.runRestoreDrill.mockRejectedValue(new Error("boom"));
    expect(toolBody(await drill()({ backupId: "b1" })).status).toBe("started");
    await new Promise((r) => setTimeout(r, 0));
  });
});
