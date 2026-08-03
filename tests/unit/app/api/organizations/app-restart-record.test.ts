// POST /api/v1/organizations/[orgId]/apps/[appId]/restart
//
// The UI's Start and Restart buttons both post here. The route only wires the
// request up — which command runs, and what gets recorded, is startOrRestartApp
// (tests/unit/lib/docker/start-app.test.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockVerifyOrgAccess, mockStartOrRestartApp, mockRefuseSystemManaged, appsFindFirst } =
  vi.hoisted(() => ({
    mockVerifyOrgAccess: vi.fn(),
    mockStartOrRestartApp: vi.fn(),
    mockRefuseSystemManaged: vi.fn(),
    appsFindFirst: vi.fn(),
  }));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/system-managed", () => ({ refuseSystemManaged: mockRefuseSystemManaged }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/docker/start-app", () => ({ startOrRestartApp: mockStartOrRestartApp }));
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
  mockStartOrRestartApp.mockResolvedValue({ success: true, action: "restarted", log: "ok" });
  mockRefuseSystemManaged.mockReturnValue(null);
  appsFindFirst.mockResolvedValue(app());
});

describe("restart route", () => {
  it("hands the app to the shared start path and reports what it did", async () => {
    const res = await POST(request(), params);

    expect(mockStartOrRestartApp).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, userId: "u1" }),
    );
    await expect(res.json()).resolves.toMatchObject({ success: true, action: "restarted" });
  });

  it("marks the trigger only when the caller used a token", async () => {
    await POST(request(), params);
    expect(mockStartOrRestartApp.mock.calls[0][0].trigger).toBeUndefined();

    mockVerifyOrgAccess.mockResolvedValue({
      organization: { id: ORG_ID },
      membership: { role: "owner" },
      session: { user: { id: "u1" }, authMethod: "token" },
    });
    await POST(request(), params);
    expect(mockStartOrRestartApp.mock.calls[1][0].trigger).toBe("api");
  });

  it("passes the reason back as `error` — that is the key the toast reads", async () => {
    mockStartOrRestartApp.mockResolvedValue({
      success: false,
      action: "none",
      failure: "no-slot",
      log: "No deployed compose project found for it-tools. Deploy the app to bring it up.",
    });

    const res = await POST(request(), params);

    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Deploy the app to bring it up"),
    });
  });

  it("404s when the child's parent is gone", async () => {
    appsFindFirst.mockResolvedValue(app({ parentAppId: "p1", composeService: "db" }));
    mockStartOrRestartApp.mockResolvedValue({
      success: false,
      action: "none",
      failure: "no-parent",
      log: "no parent",
    });

    const res = await POST(request(), params);

    expect(res.status).toBe(404);
  });

  it("honors a system-managed refusal before touching anything", async () => {
    mockRefuseSystemManaged.mockReturnValue(
      NextResponse.json({ error: "refused" }, { status: 403 }),
    );

    const res = await POST(request(), params);

    expect(res.status).toBe(403);
    expect(mockStartOrRestartApp).not.toHaveBeenCalled();
  });

  it("does nothing for an app that is not there", async () => {
    appsFindFirst.mockResolvedValue(undefined);

    const res = await POST(request(), params);

    expect(res.status).toBe(404);
    expect(mockStartOrRestartApp).not.toHaveBeenCalled();
  });
});
