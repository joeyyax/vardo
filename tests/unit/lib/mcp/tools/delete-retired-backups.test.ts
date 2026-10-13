import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminContext, captureTools, plainContext, toolBody } from "@/tests/helpers/mcp-tools";

// vardo_delete_retired_backups is admin-only and deletes nothing unless dryRun is false.

const h = vi.hoisted(() => ({
  instanceAdmin: vi.fn(async () => true),
  featureOn: vi.fn(async () => true),
  findRetiredArchives: vi.fn(),
  deleteBackups: vi.fn(),
}));

vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: h.instanceAdmin }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: h.featureOn }));
vi.mock("@/lib/backups/retired-archives", () => ({ findRetiredArchives: h.findRetiredArchives }));
vi.mock("@/lib/backups/delete-backups", () => ({ deleteBackups: h.deleteBackups }));

import { registerDeleteRetiredBackups } from "@/lib/mcp/tools/delete-retired-backups";

const tools = (c = adminContext) => captureTools(registerDeleteRetiredBackups, c);
const run = (c = adminContext) => tools(c).get("vardo_delete_retired_backups")!;

const row = { id: "b1", targetId: "t1", status: "success", storagePath: "a.dump.gz.enc" };
const jobs = [{ jobId: "j1", jobName: "db", volumeName: "pgdata", archives: 1, bytes: 10, replaced: true }];

beforeEach(() => {
  vi.clearAllMocks();
  h.instanceAdmin.mockResolvedValue(true);
  h.featureOn.mockResolvedValue(true);
  h.findRetiredArchives.mockResolvedValue({ jobs, deletable: [row] });
  h.deleteBackups.mockResolvedValue({ deleted: 1, kept: 0 });
});

describe("vardo_delete_retired_backups", () => {
  it("isn't registered without the admin scope", () => {
    expect(tools(plainContext).has("vardo_delete_retired_backups")).toBe(false);
  });

  it("refuses once the user is no longer an instance admin", async () => {
    h.instanceAdmin.mockResolvedValue(false);
    expect((await run()({ dryRun: false })).isError).toBe(true);
    expect(h.deleteBackups).not.toHaveBeenCalled();
  });

  it("lists without deleting on a dry run", async () => {
    const body = toolBody(await run()({ dryRun: true }));
    expect(h.deleteBackups).not.toHaveBeenCalled();
    expect(body).toMatchObject({ dryRun: true, deletable: 1, deleted: 0, jobs });
  });

  it("deletes only the replaced archives", async () => {
    const body = toolBody(await run()({ dryRun: false }));
    expect(h.deleteBackups).toHaveBeenCalledWith([row]);
    expect(body).toMatchObject({ dryRun: false, deleted: 1, failed: 0 });
  });
});
