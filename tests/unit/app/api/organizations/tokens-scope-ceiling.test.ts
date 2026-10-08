// POST/PATCH /api/v1/organizations/[orgId]/tokens
//
// A token could mint a cross-org token or flip its own cross-org flag, widening
// itself past the scope it was issued with.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, mockInsert, mockUpdate, inserted } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  inserted: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
const recordActivity = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/activity", () => ({ recordActivity }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/db", () => ({ db: { insert: mockInsert, update: mockUpdate, query: {} } }));

const { POST, PATCH } = await import("@/app/api/v1/organizations/[orgId]/tokens/route");

const params = { params: Promise.resolve({ orgId: "org-1" }) };

function req(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/v1/organizations/org-1/tokens", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function asToken(scope: { crossOrg?: boolean; expiresAt?: Date | null } = {}) {
  mockVerifyOrgAccess.mockResolvedValue({
    session: {
      user: { id: "u1" },
      authMethod: "token",
      tokenScope: { crossOrg: false, expiresAt: null, ...scope },
    },
  });
}

function asCookie() {
  mockVerifyOrgAccess.mockResolvedValue({ session: { user: { id: "u1" }, authMethod: "session" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  mockInsert.mockReturnValue({
    values: async (v: Record<string, unknown>) => {
      inserted.push(v);
    },
  });
  mockUpdate.mockReturnValue({
    set: () => ({ where: () => ({ returning: async () => [{ id: "t2" }] }) }),
  });
});

describe("minting a token", () => {
  it("refuses a cross-org token from a single-org token", async () => {
    asToken();
    const res = await POST(req("POST", { name: "wide", crossOrg: true }), params);
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it("rejects a request for an admin token", async () => {
    asCookie();
    const res = await POST(req("POST", { name: "admin", adminAccess: true }), params);
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it("refuses a never-expiring token from an expiring one", async () => {
    asToken({ expiresAt: new Date(Date.now() + 60_000) });
    const res = await POST(req("POST", { name: "forever" }), params);
    expect(res.status).toBe(403);
  });

  it("mints without admin and with the requested expiry by default", async () => {
    asCookie();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const res = await POST(req("POST", { name: "ci", expiresAt }), params);
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ crossOrg: false });
    expect(inserted[0]).not.toHaveProperty("adminAccess");
    expect((inserted[0].expiresAt as Date).toISOString()).toBe(expiresAt);
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "token.created",
        userId: "u1",
        metadata: expect.objectContaining({ tokenId: inserted[0].id, name: "ci" }),
      }),
    );
  });

  it("records nothing for a refused mint", async () => {
    asToken();
    await POST(req("POST", { name: "wide", crossOrg: true }), params);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("rejects an expiry in the past", async () => {
    asCookie();
    const res = await POST(req("POST", { name: "ci", expiresAt: "2020-01-01T00:00:00Z" }), params);
    expect(res.status).toBe(400);
  });
});

describe("changing a token's scope", () => {
  it("refuses to widen to cross-org from a single-org token", async () => {
    asToken();
    const res = await PATCH(req("PATCH", { id: "t2", crossOrg: true }), params);
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects a request to grant admin", async () => {
    asCookie();
    const res = await PATCH(req("PATCH", { id: "t2", adminAccess: true }), params);
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("lets a token narrow scope", async () => {
    asToken({ crossOrg: true });
    const res = await PATCH(req("PATCH", { id: "t2", crossOrg: false }), params);
    expect(res.status).toBe(200);
  });
});
