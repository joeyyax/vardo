import { describe, it, expect, vi, beforeEach } from "vitest";

// A system-org membership only counts while its user is an instance admin, so
// demotion locks the user out without waiting for the boot reconcile.

const state = vi.hoisted(() => ({
  cookieOrg: undefined as string | undefined,
  memberOf: [] as string[],
  admin: false,
}));

vi.mock("react", () => ({ cache: <T>(fn: T) => fn }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => (state.cookieOrg ? { value: state.cookieOrg } : undefined) }),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => ({ user: { id: "u1" }, session: { id: "s1" } }) } },
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: async () => true }));
vi.mock("@/lib/auth/api-token", () => ({ findApiToken: async () => null }));
vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: async () => state.admin }));

const membership = (orgId: string) => ({
  id: `m-${orgId}`,
  role: "owner",
  organizationId: orgId,
  organization: { id: orgId, slug: orgId, name: orgId, isSystemManaged: orgId === "vardo" },
});

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      memberships: {
        findFirst: async ({ where }: { where: { organizationId?: string } }) =>
          where.organizationId && state.memberOf.includes(where.organizationId)
            ? membership(where.organizationId)
            : undefined,
        findMany: async () => state.memberOf.map(membership),
      },
    },
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

const { getCurrentOrg, getUserOrganizations } = await import("@/lib/auth/session");

beforeEach(() => {
  state.cookieOrg = "vardo";
  state.memberOf = ["vardo", "home"];
  state.admin = false;
});

describe("system org membership in session resolution", () => {
  it("skips a non-admin's system-org cookie and falls back to another org", async () => {
    expect((await getCurrentOrg())?.organization.id).toBe("home");
  });

  it("never falls back to the system org for a non-admin", async () => {
    state.memberOf = ["vardo"];
    expect(await getCurrentOrg()).toBeNull();
  });

  it("keeps the system org for an instance admin", async () => {
    state.admin = true;
    expect((await getCurrentOrg())?.organization.id).toBe("vardo");
  });

  it("leaves the system org out of a non-admin's org list", async () => {
    expect((await getUserOrganizations()).map((o) => o.id)).toEqual(["home"]);
    state.admin = true;
    expect((await getUserOrganizations()).map((o) => o.id)).toEqual(["vardo", "home"]);
  });
});
