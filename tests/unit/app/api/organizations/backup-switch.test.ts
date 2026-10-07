// #876: the app's backup switch and the org default. Reading takes
// backup.view; changing either takes backup.jobs.manage, so a member is refused.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, appsFindFirst, orgsFindFirst, updates, sw } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  appsFindFirst: vi.fn(),
  orgsFindFirst: vi.fn(),
  updates: [] as Record<string, unknown>[],
  sw: {
    applyBackupSwitch: vi.fn(),
    getAppBackupSwitchState: vi.fn(),
    resolveAppBackupSwitch: vi.fn(),
    reconcileInBackground: vi.fn(),
    getSystemBackupsDefault: vi.fn(),
  },
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
      organizations: { findFirst: orgsFindFirst },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  },
}));
vi.mock("@/lib/backups/switch", async (importOriginal) => ({
  resolveBackupSwitch: (await importOriginal<typeof import("@/lib/backups/switch")>()).resolveBackupSwitch,
  ...sw,
}));

const appRoute = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/backup-switch/route");
const orgRoute = await import("@/app/api/v1/organizations/[orgId]/backups/default/route");

const ORG_ID = "org-1";
const appParams = { params: Promise.resolve({ orgId: ORG_ID, appId: "app-1" }) };
const orgParams = { params: Promise.resolve({ orgId: ORG_ID }) };
const asRole = (role: string) =>
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: ORG_ID },
    membership: { role },
    session: { user: { id: "user-1" } },
  });

function put(body: unknown) {
  return new NextRequest("http://localhost", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const APP = {
  id: "app-1",
  name: "notes",
  organizationId: ORG_ID,
  parentAppId: null,
  backupsEnabled: null,
  organization: { backupsEnabled: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  asRole("admin");
  appsFindFirst.mockResolvedValue(APP);
  orgsFindFirst.mockResolvedValue({ backupsEnabled: null });
  sw.getAppBackupSwitchState.mockImplementation(async (a: { backupsEnabled: boolean | null }) => ({
    enabled: a.backupsEnabled ?? true,
    source: a.backupsEnabled === null ? "system" : "app",
    setting: a.backupsEnabled,
    status: "covered",
  }));
  sw.resolveAppBackupSwitch.mockResolvedValue({ enabled: false, source: "app" });
  sw.applyBackupSwitch.mockResolvedValue("disabled");
  sw.getSystemBackupsDefault.mockResolvedValue(true);
});

describe("app backup switch", () => {
  it("lets a member read it", async () => {
    asRole("member");

    const res = await appRoute.GET(new NextRequest("http://localhost"), appParams);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, source: "system" });
  });

  it("turns an app off and stops its schedule", async () => {
    const res = await appRoute.PUT(put({ enabled: false }), appParams);

    expect(res.status).toBe(200);
    expect(updates).toEqual([expect.objectContaining({ backupsEnabled: false })]);
    expect(sw.applyBackupSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "app-1", organizationId: ORG_ID }),
      false,
      { reenable: true },
    );
    expect(await res.json()).toMatchObject({ enabled: false, source: "app" });
  });

  it("resets to inherit with null", async () => {
    sw.resolveAppBackupSwitch.mockResolvedValue({ enabled: true, source: "system" });

    const res = await appRoute.PUT(put({ enabled: null }), appParams);

    expect(res.status).toBe(200);
    expect(updates).toEqual([expect.objectContaining({ backupsEnabled: null })]);
    expect(sw.applyBackupSwitch).toHaveBeenCalledWith(expect.anything(), true, { reenable: true });
  });

  it("refuses a member", async () => {
    asRole("member");

    const res = await appRoute.PUT(put({ enabled: false }), appParams);

    expect(res.status).toBe(403);
    expect(updates).toEqual([]);
  });

  it("rejects a malformed body", async () => {
    const res = await appRoute.PUT(put({ enabled: "yes" }), appParams);

    expect(res.status).toBe(400);
  });

  it("returns 404 for an app of another org", async () => {
    appsFindFirst.mockResolvedValue(undefined);

    const res = await appRoute.PUT(put({ enabled: true }), appParams);

    expect(res.status).toBe(404);
  });

  it("sends a compose child to its stack", async () => {
    appsFindFirst.mockResolvedValue({ ...APP, parentAppId: "stack-1" });

    const res = await appRoute.PUT(put({ enabled: true }), appParams);

    expect(res.status).toBe(409);
    expect(sw.applyBackupSwitch).not.toHaveBeenCalled();
  });
});

describe("org backup default", () => {
  it("reads as inheriting the system default", async () => {
    asRole("member");

    const res = await orgRoute.GET(new NextRequest("http://localhost"), orgParams);

    expect(await res.json()).toEqual({ setting: null, systemDefault: true, enabled: true, source: "system" });
  });

  it("saves the default and reconciles only inheriting apps", async () => {
    const res = await orgRoute.PUT(put({ enabled: false }), orgParams);

    expect(res.status).toBe(200);
    expect(updates).toEqual([expect.objectContaining({ backupsEnabled: false })]);
    expect(sw.reconcileInBackground).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      inheritOnly: true,
      reenable: true,
    });
    expect(await res.json()).toMatchObject({ setting: false, enabled: false, source: "org" });
  });

  it("refuses a member", async () => {
    asRole("member");

    const res = await orgRoute.PUT(put({ enabled: false }), orgParams);

    expect(res.status).toBe(403);
    expect(sw.reconcileInBackground).not.toHaveBeenCalled();
  });
});
