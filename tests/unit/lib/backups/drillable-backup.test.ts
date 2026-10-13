import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { query: { backups: { findFirst: h.findFirst } } } }));

import { findDrillableBackup } from "@/lib/backups/org-backup";

const row = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  status: "success",
  appId: "a1",
  organizationId: "org-1",
  app: { id: "a1", name: "web", organizationId: "org-1" },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("findDrillableBackup", () => {
  it("returns a successful backup the org owns", async () => {
    h.findFirst.mockResolvedValue(row());
    const res = await findDrillableBackup("org-1", "b1");
    expect(res).toMatchObject({ ok: true, backup: { id: "b1" } });
  });

  it("reports a missing backup", async () => {
    h.findFirst.mockResolvedValue(undefined);
    expect(await findDrillableBackup("org-1", "nope")).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports a backup whose app belongs to another org as not found", async () => {
    h.findFirst.mockResolvedValue(row({ app: { id: "a1", name: "web", organizationId: "org-2" } }));
    expect(await findDrillableBackup("org-1", "b1")).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports a backup that didn't succeed", async () => {
    h.findFirst.mockResolvedValue(row({ status: "failed" }));
    expect(await findDrillableBackup("org-1", "b1")).toEqual({ ok: false, reason: "not_successful" });
  });
});
