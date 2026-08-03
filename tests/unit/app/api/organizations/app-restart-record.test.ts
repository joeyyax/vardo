// POST /api/v1/organizations/[orgId]/apps/[appId]/restart
//
// The click was correctly wired and still read as a no-op: nothing was written,
// so the page showed the container that had just been replaced and no record
// existed anywhere afterwards. Both halves are asserted here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyOrgAccess,
  mockRestartContainers,
  mockResolveDefaultEnv,
  mockReconcileAppNow,
  mockRecordLifecycle,
  appsFindFirst,
} = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockRestartContainers: vi.fn(),
  mockResolveDefaultEnv: vi.fn(),
  mockReconcileAppNow: vi.fn(),
  mockRecordLifecycle: vi.fn(),
  appsFindFirst: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/docker/deploy", () => ({ restartContainers: mockRestartContainers }));
vi.mock("@/lib/docker/resolve-env", () => ({ resolveDefaultEnv: mockResolveDefaultEnv }));
vi.mock("@/lib/docker/status-reconcile", () => ({ reconcileAppNow: mockReconcileAppNow }));
vi.mock("@/lib/activity/lifecycle", () => ({ recordLifecycle: mockRecordLifecycle }));
vi.mock("@/lib/db", () => ({ db: { query: { apps: { findFirst: appsFindFirst } } } }));

const { POST } = await import(
  "@/app/api/v1/organizations/[orgId]/apps/[appId]/restart/route"
);

const ORG_ID = "org-1";
const APP_ID = "app-a";
const params = { params: Promise.resolve({ orgId: ORG_ID, appId: APP_ID }) };

function request() {
  return new NextRequest(`http://localhost/api/v1/organizations/${ORG_ID}/apps/${APP_ID}/restart`, {
    method: "POST",
  });
}

function app(overrides: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    name: "it-tools",
    status: "active",
    isSystemManaged: false,
    parentAppId: null,
    composeService: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: ORG_ID },
    membership: { role: "owner" },
    session: { user: { id: "u1" }, authMethod: "session" },
  });
  mockResolveDefaultEnv.mockResolvedValue({ name: "production" });
  mockRestartContainers.mockResolvedValue({ success: true, log: "ok" });
  appsFindFirst.mockResolvedValue(app());
});

describe("restart route", () => {
  it("refreshes the row and records the restart", async () => {
    await POST(request(), params);

    expect(mockReconcileAppNow).toHaveBeenCalledWith(APP_ID);
    expect(mockRecordLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "restarted", userId: "u1", organizationId: ORG_ID }),
    );
  });

  it("calls it a start when the app was off — the button posts here too", async () => {
    appsFindFirst.mockResolvedValue(app({ status: "stopped" }));
    mockReconcileAppNow.mockResolvedValue("active");

    await POST(request(), params);

    expect(mockRecordLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "started" }),
    );
  });

  it("claims no start when compose exited clean but nothing came up", async () => {
    appsFindFirst.mockResolvedValue(app({ status: "stopped" }));
    mockReconcileAppNow.mockResolvedValue("missing");

    await POST(request(), params);

    expect(mockRecordLifecycle).not.toHaveBeenCalled();
  });

  it("marks the trigger only when the caller used a token", async () => {
    await POST(request(), params);
    expect(mockRecordLifecycle.mock.calls[0][0].trigger).toBeUndefined();

    mockVerifyOrgAccess.mockResolvedValue({
      organization: { id: ORG_ID },
      membership: { role: "owner" },
      session: { user: { id: "u1" }, authMethod: "token" },
    });
    await POST(request(), params);
    expect(mockRecordLifecycle.mock.calls[1][0].trigger).toBe("api");
  });

  it("writes nothing when the restart failed", async () => {
    mockRestartContainers.mockResolvedValue({ success: false, log: "no slot dir" });

    await POST(request(), params);

    expect(mockReconcileAppNow).not.toHaveBeenCalled();
    expect(mockRecordLifecycle).not.toHaveBeenCalled();
  });

  it("writes nothing for an app that is not there", async () => {
    appsFindFirst.mockResolvedValue(undefined);

    const res = await POST(request(), params);

    expect(res.status).toBe(404);
    expect(mockRestartContainers).not.toHaveBeenCalled();
    expect(mockReconcileAppNow).not.toHaveBeenCalled();
    expect(mockRecordLifecycle).not.toHaveBeenCalled();
  });
});
