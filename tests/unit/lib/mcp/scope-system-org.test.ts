import { describe, it, expect, vi, beforeEach } from "vitest";

// MCP tokens reach the system org only while their user is an instance admin.

const state = vi.hoisted(() => ({ admin: false }));

const row = (organizationId: string) => ({
  organizationId,
  role: "owner",
  organization: { isSystemManaged: organizationId === "vardo" },
});

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      memberships: {
        findFirst: async ({ where }: { where: { organizationId: string } }) => row(where.organizationId),
        findMany: async () => [row("home"), row("vardo")],
      },
    },
  },
}));
vi.mock("@/lib/db/schema", () => ({
  apps: {},
  memberships: { userId: "userId", organizationId: "organizationId" },
  organizations: {},
  projects: {},
}));
vi.mock("drizzle-orm", () => ({
  and: (...parts: object[]) => Object.assign({}, ...parts),
  eq: (column: string, value: string) => ({ [column]: value }),
  inArray: () => ({}),
  sql: () => ({}),
}));
vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: async () => state.admin }));

const { canAccessOrg, accessibleOrgIds } = await import("@/lib/mcp/scope");

const token = { userId: "u1", organizationId: "vardo", crossOrg: true };

beforeEach(() => {
  state.admin = false;
});

describe("system org via MCP", () => {
  it("refuses a non-admin's token", async () => {
    expect(await canAccessOrg(token, "vardo", "org.view")).toBe(false);
    expect(await canAccessOrg(token, "home", "org.view")).toBe(true);
    expect(await accessibleOrgIds(token, "org.view")).toEqual(["home"]);
  });

  it("allows an instance admin's token", async () => {
    state.admin = true;
    expect(await canAccessOrg(token, "vardo", "org.view")).toBe(true);
    expect((await accessibleOrgIds(token, "org.view")).sort()).toEqual(["home", "vardo"]);
  });
});
