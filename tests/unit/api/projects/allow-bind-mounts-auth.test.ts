import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ isAppAdmin: false, role: "owner", updated: vi.fn() }));

vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: async (orgId: string) => ({
    organization: { id: orgId },
    membership: { role: state.role },
    session: { user: { id: "u1" } },
  }),
}));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: async () => state.isAppAdmin }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      projects: {
        findFirst: vi.fn(async () => ({
          id: "p1",
          name: "web",
          organizationId: "o1",
          isSystemManaged: false,
          allowBindMounts: false,
          allowDockerSocket: true,
        })),
      },
    },
    update: () => ({
      set: (values: unknown) => {
        state.updated(values);
        return { where: () => ({ returning: async () => [{ id: "p1", ...(values as object) }] }) };
      },
    }),
  },
}));

const { PATCH } = await import("@/app/api/v1/organizations/[orgId]/projects/[projectId]/route");

const patch = (body: unknown) =>
  (PATCH as (r: NextRequest, c: unknown) => Promise<Response>)(
    new NextRequest("http://localhost/api/v1/organizations/o1/projects/p1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId: "o1", projectId: "p1" }) },
  );

beforeEach(() => {
  state.isAppAdmin = false;
  state.role = "owner";
  state.updated.mockReset();
});

describe("project host mount flags", () => {
  for (const flag of ["allowBindMounts", "allowDockerSocket"]) {
    it(`refuses an org owner who isn't an instance admin setting ${flag}`, async () => {
      const res = await patch({ [flag]: flag === "allowBindMounts" });
      expect(res.status).toBe(403);
      expect(state.updated).not.toHaveBeenCalled();
    });

    it(`lets an instance admin set ${flag}`, async () => {
      state.isAppAdmin = true;
      state.role = "member";
      const next = flag === "allowBindMounts";
      const res = await patch({ [flag]: next });
      expect(res.status).not.toBe(403);
      expect(state.updated).toHaveBeenCalledWith(expect.objectContaining({ [flag]: next }));
    });
  }

  it.each(["owner", "admin"])("lets an org %s save other fields alongside unchanged flags", async (role) => {
    state.role = role;
    const res = await patch({ displayName: "Web", allowBindMounts: false, allowDockerSocket: true });
    expect(res.status).toBe(200);
    expect(state.updated).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Web" }));
  });

  it("refuses an org admin who changes one flag among unchanged ones", async () => {
    state.role = "admin";
    const res = await patch({ displayName: "Web", allowBindMounts: true, allowDockerSocket: true });
    expect(res.status).toBe(403);
    expect(state.updated).not.toHaveBeenCalled();
  });

  it("lets an org owner change other fields", async () => {
    const res = await patch({ displayName: "Web" });
    expect(res.status).not.toBe(403);
  });
});
