// /api/v1/organizations/[orgId]/backups/coverage (#874)
//
// Lists apps no job backs up and opts one in. Both take backup.jobs.manage,
// so a member is refused.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, appsFindFirst, targetsFindFirst, resolveBackupTarget, listUncoveredApps, optInApp, appUpdates } =
  vi.hoisted(() => ({
    appUpdates: [] as Record<string, unknown>[],
    mockVerifyOrgAccess: vi.fn(),
    appsFindFirst: vi.fn(),
    targetsFindFirst: vi.fn(),
    resolveBackupTarget: vi.fn(),
    listUncoveredApps: vi.fn(),
    optInApp: vi.fn(),
  }));

vi.mock("@/lib/api/verify-access", async () => {
  const { gateOrgAccess } = await import("../../../helpers/verify-access");
  return { verifyOrgAccess: gateOrgAccess(mockVerifyOrgAccess) };
});
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: appsFindFirst },
      backupTargets: { findFirst: targetsFindFirst },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          appUpdates.push(values);
        },
      }),
    }),
  },
}));
vi.mock("@/lib/backups/auto-backup", () => ({ resolveBackupTarget }));
vi.mock("@/lib/backups/enroll", () => ({ listUncoveredApps, optInApp }));

const { GET, POST } = await import("@/app/api/v1/organizations/[orgId]/backups/coverage/route");

const ORG_ID = "org-1";
const params = { params: Promise.resolve({ orgId: ORG_ID }) };
const asRole = (role: string) =>
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: ORG_ID },
    membership: { role },
    session: { user: { id: "user-1" } },
  });

function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/organizations/${ORG_ID}/backups/coverage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  appUpdates.length = 0;
  asRole("admin");
  appsFindFirst.mockResolvedValue({ id: "app-1", name: "notes" });
  targetsFindFirst.mockResolvedValue({ id: "tgt-nas" });
  resolveBackupTarget.mockResolvedValue({ id: "tgt-r2" });
  listUncoveredApps.mockResolvedValue([{ id: "app-1", name: "notes", status: "uncovered", volumes: [] }]);
  optInApp.mockResolvedValue({ jobId: "job-1", included: ["vol-1"] });
});

describe("GET coverage", () => {
  it("lists uncovered apps with the default target for an admin", async () => {
    const res = await GET(new NextRequest("http://localhost"), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      apps: [{ id: "app-1", name: "notes", status: "uncovered", volumes: [] }],
      defaultTargetId: "tgt-r2",
    });
  });

  it("refuses a member", async () => {
    asRole("member");

    const res = await GET(new NextRequest("http://localhost"), params);

    expect(res.status).toBe(403);
    expect(listUncoveredApps).not.toHaveBeenCalled();
  });
});

describe("POST coverage", () => {
  it("opts an app in on the default target when none is chosen", async () => {
    const res = await POST(post({ appId: "app-1" }), params);

    expect(res.status).toBe(200);
    expect(optInApp).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app-1", organizationId: ORG_ID, targetId: "tgt-r2" }),
    );
    expect(appUpdates).toEqual([expect.objectContaining({ backupsEnabled: true })]);
  });

  it("uses the chosen target", async () => {
    const res = await POST(post({ appId: "app-1", targetId: "tgt-nas", volumeIds: ["vol-1"] }), params);

    expect(res.status).toBe(200);
    expect(optInApp).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "tgt-nas", volumeIds: ["vol-1"] }),
    );
  });

  it("rejects a target outside the org", async () => {
    targetsFindFirst.mockResolvedValue(undefined);

    const res = await POST(post({ appId: "app-1", targetId: "tgt-foreign" }), params);

    expect(res.status).toBe(404);
    expect(optInApp).not.toHaveBeenCalled();
  });

  it("returns 409 when no target exists", async () => {
    resolveBackupTarget.mockResolvedValue(null);

    const res = await POST(post({ appId: "app-1" }), params);

    expect(res.status).toBe(409);
  });

  it("rejects an app of another org", async () => {
    appsFindFirst.mockResolvedValue(undefined);

    const res = await POST(post({ appId: "app-foreign" }), params);

    expect(res.status).toBe(404);
    expect(optInApp).not.toHaveBeenCalled();
  });

  it("refuses a member", async () => {
    asRole("member");

    const res = await POST(post({ appId: "app-1" }), params);

    expect(res.status).toBe(403);
    expect(optInApp).not.toHaveBeenCalled();
  });
});
