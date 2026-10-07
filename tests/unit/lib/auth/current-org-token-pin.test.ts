import { describe, it, expect, vi, beforeEach } from "vitest";

// A token is pinned to the org it was minted for. Once its user leaves that
// org, getCurrentOrg fails closed instead of falling back to another membership.

const state = vi.hoisted(() => ({
  bearer: null as string | null,
  cookieOrg: undefined as string | undefined,
  memberOf: [] as string[],
}));

vi.mock("react", () => ({ cache: <T>(fn: T) => fn }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.bearer ? { authorization: `Bearer ${state.bearer}` } : {}),
  cookies: async () => ({
    get: () => (state.cookieOrg ? { value: state.cookieOrg } : undefined),
  }),
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => ({ user: { id: "u1" }, session: { id: "s1" } }),
    },
  },
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: async () => true }));
vi.mock("@/lib/auth/api-token", () => ({
  findApiToken: async () => ({
    id: "t1",
    userId: "u1",
    organizationId: "org-a",
    crossOrg: false,
    expiresAt: null,
  }),
}));

const membership = (orgId: string) => ({
  id: `m-${orgId}`,
  role: "admin",
  organizationId: orgId,
  organization: { id: orgId, isSystemManaged: false },
});

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      user: { findFirst: async () => ({ id: "u1", name: "U", email: "u@x" }) },
      memberships: {
        findFirst: async ({ where }: { where: { organizationId?: string } }) =>
          where.organizationId && state.memberOf.includes(where.organizationId)
            ? membership(where.organizationId)
            : undefined,
        findMany: async () => state.memberOf.map(membership),
      },
    },
    update: () => ({ set: () => ({ where: () => ({ catch: () => {} }) }) }),
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: string) => ({ [column]: value }),
  and: (...parts: object[]) => Object.assign({}, ...parts),
}));
vi.mock("@/lib/db/schema", () => ({
  memberships: { userId: "userId", organizationId: "organizationId" },
  apiTokens: { id: "id" },
  user: { id: "id" },
}));

const { getCurrentOrg } = await import("@/lib/auth/session");

beforeEach(() => {
  state.bearer = null;
  state.cookieOrg = undefined;
  state.memberOf = [];
});

describe("getCurrentOrg", () => {
  it("resolves a token to its bound org", async () => {
    state.bearer = "vardo_tok";
    state.memberOf = ["org-a", "org-b"];
    expect((await getCurrentOrg())?.organization.id).toBe("org-a");
  });

  it("fails closed when the token's user has left its bound org", async () => {
    state.bearer = "vardo_tok";
    state.memberOf = ["org-b"];
    expect(await getCurrentOrg()).toBeNull();
  });

  it("ignores the org cookie for a token", async () => {
    state.bearer = "vardo_tok";
    state.cookieOrg = "org-b";
    state.memberOf = ["org-b"];
    expect(await getCurrentOrg()).toBeNull();
  });

  it("still falls back to the first membership for a cookie session", async () => {
    state.cookieOrg = "org-gone";
    state.memberOf = ["org-b"];
    expect((await getCurrentOrg())?.organization.id).toBe("org-b");
  });
});
