// /api/v1/organizations/[orgId]
//
// Org access goes through the shared verifyOrgAccess, so a token pinned to one
// org can't read or edit another the user also belongs to. `trusted` stays
// instance-admin only and works on any org.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  access: null as null | { role: string },
  membershipRow: null as null | { id: string; role: string },
  instanceAdmin: false,
  updated: vi.fn(),
}));

vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/auth/session", () => {
  const session = { user: { id: "u1" }, authMethod: "session" };
  return { getSession: async () => session, requireSession: async () => session };
});
vi.mock("@/lib/auth/admin", () => ({
  isAppAdmin: async () => state.instanceAdmin,
  requireAppAdmin: async () => {
    if (!state.instanceAdmin) throw new Error("Forbidden");
  },
}));
vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: async (orgId: string) =>
    state.access
      ? {
          organization: { id: orgId, name: "Org" },
          membership: { id: "m1", role: state.access.role },
          session: { user: { id: "u1" } },
        }
      : null,
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      memberships: { findFirst: async () => state.membershipRow },
      organizations: { findFirst: async () => ({ id: "o1", name: "Org" }) },
    },
    update: () => ({
      set: (values: unknown) => {
        state.updated(values);
        return { where: () => ({ returning: async () => [{ id: "o1", ...(values as object) }] }) };
      },
    }),
  },
}));

const { GET, PATCH } = await import("@/app/api/v1/organizations/[orgId]/route");

const params = { params: Promise.resolve({ orgId: "o1" }) };
const get = () => GET(new NextRequest("http://localhost/api/v1/organizations/o1"), params);
const patch = (body: unknown) =>
  (PATCH as (r: NextRequest, c: unknown) => Promise<Response>)(
    new NextRequest("http://localhost/api/v1/organizations/o1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    params,
  );

/** A member of o1 whose credential verifyOrgAccess does (or doesn't) admit. */
function as(role: string, { admitted = true, instanceAdmin = false } = {}) {
  state.membershipRow = { id: "m1", role };
  state.access = admitted ? { role } : null;
  state.instanceAdmin = instanceAdmin;
}

beforeEach(() => {
  state.updated.mockReset();
});

describe("GET org", () => {
  it("returns the org to a member", async () => {
    as("member");
    expect((await get()).status).toBe(200);
  });

  it("refuses a credential pinned to another org", async () => {
    as("owner", { admitted: false });
    expect((await get()).status).toBe(403);
  });
});

describe("PATCH org", () => {
  it("refuses a member", async () => {
    as("member");
    expect((await patch({ name: "New" })).status).toBe(403);
    expect(state.updated).not.toHaveBeenCalled();
  });

  it.each(["admin", "owner"])("lets an org %s rename it", async (role) => {
    as(role);
    expect((await patch({ name: "New" })).status).toBe(200);
    expect(state.updated).toHaveBeenCalledWith(expect.objectContaining({ name: "New" }));
  });

  it("refuses an owner whose credential is pinned to another org", async () => {
    as("owner", { admitted: false });
    expect((await patch({ name: "New" })).status).toBe(403);
    expect(state.updated).not.toHaveBeenCalled();
  });

  it("refuses trusted from an org owner who isn't an instance admin", async () => {
    as("owner");
    expect((await patch({ trusted: true })).status).toBe(403);
    expect(state.updated).not.toHaveBeenCalled();
  });

  it("lets an instance admin set trusted on an org they don't belong to", async () => {
    state.membershipRow = null;
    state.access = null;
    state.instanceAdmin = true;
    expect((await patch({ trusted: true })).status).toBe(200);
    expect(state.updated).toHaveBeenCalledWith(expect.objectContaining({ trusted: true }));
  });

  it("still needs org admin for an instance admin's rename", async () => {
    as("member", { instanceAdmin: true });
    expect((await patch({ name: "New", trusted: true })).status).toBe(403);
    expect(state.updated).not.toHaveBeenCalled();
  });
});
