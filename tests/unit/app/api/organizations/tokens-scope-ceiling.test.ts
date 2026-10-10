// POST/PATCH /api/v1/organizations/[orgId]/tokens
//
// A token could mint a cross-org token or flip its own cross-org flag, widening
// itself past the scope it was issued with. Only an instance admin's session grants the admin scope.

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
const isAppAdmin = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin }));
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

function asToken(scope: { crossOrg?: boolean; expiresAt?: Date | null; capabilities?: ReadonlySet<string> | null } = {}) {
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
  isAppAdmin.mockResolvedValue(false);
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

  it("refuses the admin scope to a user who isn't an instance admin", async () => {
    asCookie();
    const res = await POST(req("POST", { name: "admin", adminAccess: true }), params);
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it("refuses the admin scope to a token, even an admin's", async () => {
    asToken();
    isAppAdmin.mockResolvedValue(true);
    const res = await POST(req("POST", { name: "admin", adminAccess: true }), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "A token cannot grant the admin scope" });
    expect(inserted).toHaveLength(0);
  });

  it("mints an admin-scoped token for an instance admin's session and records it", async () => {
    asCookie();
    isAppAdmin.mockResolvedValue(true);
    const res = await POST(req("POST", { name: "admin", adminAccess: true }), params);
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ adminAccess: true });
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "token.created", metadata: expect.objectContaining({ adminAccess: true }) }),
    );
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
    expect(inserted[0]).toMatchObject({ crossOrg: false, adminAccess: false });
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

describe("capability scopes", () => {
  it("stores full by default", async () => {
    asCookie();
    const res = await POST(req("POST", { name: "ci" }), params);
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ scope: "full", capabilities: null });
  });

  it("stores a preset and an org binding", async () => {
    asCookie();
    const res = await POST(req("POST", { name: "ci", scope: "deploy", crossOrg: false }), params);
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ scope: "deploy", capabilities: null, crossOrg: false });
  });

  it("stores custom capabilities", async () => {
    asCookie();
    const res = await POST(req("POST", { name: "ci", scope: "custom", capabilities: ["app.view", "app.deploy"] }), params);
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ scope: "custom", capabilities: ["app.view", "app.deploy"] });
  });

  it("rejects unknown capabilities, custom without any, and capabilities on a preset", async () => {
    asCookie();
    for (const body of [
      { name: "x", scope: "custom", capabilities: ["root.all"] },
      { name: "x", scope: "custom" },
      { name: "x", scope: "read", capabilities: ["app.view"] },
      { name: "x", scope: "admin" },
    ]) {
      expect((await POST(req("POST", body), params)).status).toBe(400);
    }
    expect(inserted).toHaveLength(0);
  });

  it("refuses a full token from a scoped one", async () => {
    asToken({ capabilities: new Set(["app.view", "org.tokens.manage"]) });
    const res = await POST(req("POST", { name: "wide" }), params);
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it("refuses a capability the minting token lacks", async () => {
    asToken({ capabilities: new Set(["app.view", "org.tokens.manage"]) });
    const res = await POST(req("POST", { name: "x", scope: "custom", capabilities: ["app.deploy"] }), params);
    expect(res.status).toBe(403);
  });

  it("lets a scoped token mint a narrower one", async () => {
    asToken({ capabilities: new Set(["app.view", "org.view", "org.tokens.manage"]) });
    const res = await POST(req("POST", { name: "x", scope: "custom", capabilities: ["app.view"] }), params);
    expect(res.status).toBe(201);
  });
});

describe("changing a token's scope", () => {
  it("refuses to widen to cross-org from a single-org token", async () => {
    asToken();
    const res = await PATCH(req("PATCH", { id: "t2", crossOrg: true }), params);
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses to grant admin unless an instance admin's session asks", async () => {
    asCookie();
    expect((await PATCH(req("PATCH", { id: "t2", adminAccess: true }), params)).status).toBe(403);
    asToken();
    isAppAdmin.mockResolvedValue(true);
    expect((await PATCH(req("PATCH", { id: "t2", adminAccess: true }), params)).status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("grants admin for an instance admin's session", async () => {
    asCookie();
    isAppAdmin.mockResolvedValue(true);
    const res = await PATCH(req("PATCH", { id: "t2", adminAccess: true }), params);
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("lets anyone drop the admin scope", async () => {
    asToken();
    const res = await PATCH(req("PATCH", { id: "t2", adminAccess: false }), params);
    expect(res.status).toBe(200);
  });

  it("rejects a change with nothing to change", async () => {
    asCookie();
    const res = await PATCH(req("PATCH", { id: "t2" }), params);
    expect(res.status).toBe(400);
  });

  it("lets a token narrow scope", async () => {
    asToken({ crossOrg: true });
    const res = await PATCH(req("PATCH", { id: "t2", crossOrg: false }), params);
    expect(res.status).toBe(200);
  });
});

describe("linked-instance scope", () => {
  it("is off by default", async () => {
    asCookie();
    await POST(req("POST", { name: "ci" }), params);
    expect(inserted[0]).toMatchObject({ linkedInstances: false });
  });

  it("is refused to a user who isn't an instance admin", async () => {
    asCookie();
    const res = await POST(req("POST", { name: "multi", linkedInstances: true }), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only an instance admin can grant access to linked instances" });
    expect(inserted).toHaveLength(0);
  });

  it("is refused to a token, even an admin's", async () => {
    asToken();
    isAppAdmin.mockResolvedValue(true);
    expect((await POST(req("POST", { name: "multi", linkedInstances: true }), params)).status).toBe(403);
    expect((await PATCH(req("PATCH", { id: "t2", linkedInstances: true }), params)).status).toBe(403);
    expect(inserted).toHaveLength(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("is granted by an instance admin's session and recorded", async () => {
    asCookie();
    isAppAdmin.mockResolvedValue(true);
    expect((await POST(req("POST", { name: "multi", linkedInstances: true }), params)).status).toBe(201);
    expect(inserted[0]).toMatchObject({ linkedInstances: true });
    expect((await PATCH(req("PATCH", { id: "t2", linkedInstances: true }), params)).status).toBe(200);
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "token.updated", metadata: expect.objectContaining({ linkedInstances: true }) }),
    );
  });

  it("can be dropped by anyone", async () => {
    asToken();
    expect((await PATCH(req("PATCH", { id: "t2", linkedInstances: false }), params)).status).toBe(200);
  });
});
