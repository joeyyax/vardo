import { describe, it, expect, vi, beforeEach } from "vitest";

const { state, listInstallations, insert } = vi.hoisted(() => ({
  state: { admin: false },
  listInstallations: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@/lib/auth/admin", () => ({
  requireAppAdmin: async () => {
    if (!state.admin) throw new Error("Forbidden");
    return { user: { id: "u1" }, authMethod: "session" };
  },
}));
vi.mock("@/lib/git-integration/app", () => ({
  getAppOctokit: async () => ({ rest: { apps: { listInstallations } } }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: { githubAppInstallations: { findMany: async () => [] } },
    insert: () => ({ values: () => ({ onConflictDoUpdate: insert }) }),
  },
}));

const { GET } = await import("@/app/api/v1/github/installations/sync/route");

beforeEach(() => {
  listInstallations.mockReset();
  listInstallations.mockResolvedValue({
    data: [{ id: 42, account: { login: "someone-else", type: "Organization" } }],
  });
  insert.mockReset();
});

describe("GitHub installation sync", () => {
  it("refuses a signed-in non-admin, who would otherwise link every installation", async () => {
    state.admin = false;
    const res = await GET();
    expect(res.status).toBe(403);
    expect(listInstallations).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("links installations for an instance admin", async () => {
    state.admin = true;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
