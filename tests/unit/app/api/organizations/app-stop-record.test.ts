// POST /api/v1/organizations/[orgId]/apps/[appId]/stop
//
// stopProject already writes the status, so a stop is visible. What it never
// left was a record of who turned the app off.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, mockStopProject, mockRecordLifecycle, appsFindFirst } = vi.hoisted(
  () => ({
    mockVerifyOrgAccess: vi.fn(),
    mockStopProject: vi.fn(),
    mockRecordLifecycle: vi.fn(),
    appsFindFirst: vi.fn(),
  }),
);

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/docker/deploy", () => ({ stopProject: mockStopProject }));
vi.mock("@/lib/activity/lifecycle", () => ({ recordLifecycle: mockRecordLifecycle }));
vi.mock("@/lib/db", () => ({ db: { query: { apps: { findFirst: appsFindFirst } } } }));

const { POST } = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/stop/route");

const ORG_ID = "org-1";
const APP_ID = "app-a";
const params = { params: Promise.resolve({ orgId: ORG_ID, appId: APP_ID }) };

function request() {
  return new NextRequest(`http://localhost/api/v1/organizations/${ORG_ID}/apps/${APP_ID}/stop`, {
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: ORG_ID },
    membership: { role: "owner" },
    session: { user: { id: "u1" }, authMethod: "session" },
  });
  mockStopProject.mockResolvedValue({ success: true, log: "ok" });
  appsFindFirst.mockResolvedValue({
    id: APP_ID,
    name: "it-tools",
    isSystemManaged: false,
    parentAppId: null,
    composeService: null,
  });
});

describe("stop route", () => {
  it("records who stopped it", async () => {
    await POST(request(), params);

    expect(mockRecordLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stopped", userId: "u1", organizationId: ORG_ID }),
    );
  });

  it("records nothing when the stop failed", async () => {
    mockStopProject.mockResolvedValue({ success: false, log: "boom" });

    await POST(request(), params);

    expect(mockRecordLifecycle).not.toHaveBeenCalled();
  });

  it("records nothing for a refused stop of Vardo's own stack", async () => {
    appsFindFirst.mockResolvedValue({
      id: APP_ID,
      name: "vardo",
      isSystemManaged: true,
      parentAppId: null,
      composeService: null,
    });

    const res = await POST(request(), params);

    expect(res.status).toBe(403);
    expect(mockStopProject).not.toHaveBeenCalled();
    expect(mockRecordLifecycle).not.toHaveBeenCalled();
  });
});
