import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// MCP organization scoping
// ---------------------------------------------------------------------------
// A token reaches an org only while its user holds a live membership there.
// A normal token is additionally pinned to the org it was minted for; a
// cross-org token is not.
//
// Under test: lib/mcp/scope.ts

// userId -> orgIds the membership table says they belong to.
let membershipTable: Record<string, string[]> = {};

const membershipFindFirst = vi.fn(async (args: { where: unknown }) => {
  const { userId, organizationId } = readMembershipFilter(args);
  return membershipTable[userId]?.includes(organizationId)
    ? { id: `${userId}:${organizationId}`, role: "owner" }
    : undefined;
});

const membershipFindMany = vi.fn(async (args: { where: unknown }) => {
  const { userId } = readMembershipFilter(args);
  return (membershipTable[userId] ?? []).map((organizationId) => ({
    organizationId,
  }));
});

// The mocked drizzle helpers below record their arguments so the fake table can
// answer the same question the real query would.
type Filter = { userId?: string; organizationId?: string };

function readMembershipFilter(args: { where: unknown }): {
  userId: string;
  organizationId: string;
} {
  const f = args.where as Filter;
  return { userId: f.userId ?? "", organizationId: f.organizationId ?? "" };
}

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      memberships: {
        findFirst: (a: { where: unknown }) => membershipFindFirst(a),
        findMany: (a: { where: unknown }) => membershipFindMany(a),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  apps: {},
  deployments: {},
  groupEnvironments: {},
  memberships: { userId: "userId", organizationId: "organizationId" },
  organizations: {},
  projects: {},
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: Filter[]) => Object.assign({}, ...parts),
  eq: (column: string, value: string) => ({ [column]: value }),
  inArray: (column: string, values: string[]) => ({ [column]: values }),
  sql: () => ({ false: true }),
}));

const HOME = "org-homelab";
const OTHER = "org-vardo";
const FOREIGN = "org-someone-else";

const normalToken = { userId: "u1", organizationId: HOME, crossOrg: false };
const crossToken = { userId: "u1", organizationId: HOME, crossOrg: true };

async function scope() {
  return import("@/lib/mcp/scope");
}

beforeEach(() => {
  vi.clearAllMocks();
  membershipTable = { u1: [HOME, OTHER] };
});

describe("canAccessOrg", () => {
  it("lets a normal token reach its own org", async () => {
    const { canAccessOrg } = await scope();
    expect(await canAccessOrg(normalToken, HOME)).toBe(true);
  });

  it("refuses a normal token another org, even one its user belongs to", async () => {
    const { canAccessOrg } = await scope();
    expect(await canAccessOrg(normalToken, OTHER)).toBe(false);
  });

  it("lets a cross-org token reach an org its user belongs to", async () => {
    const { canAccessOrg } = await scope();
    expect(await canAccessOrg(crossToken, OTHER)).toBe(true);
  });

  it("refuses a cross-org token an org its user does not belong to", async () => {
    const { canAccessOrg } = await scope();
    expect(await canAccessOrg(crossToken, FOREIGN)).toBe(false);
  });

  it("revokes access as soon as the membership row is gone", async () => {
    const { canAccessOrg } = await scope();
    expect(await canAccessOrg(crossToken, OTHER)).toBe(true);

    membershipTable = { u1: [HOME] };
    expect(await canAccessOrg(crossToken, OTHER)).toBe(false);
  });

  it("revokes the token's own org when its user is removed from it", async () => {
    const { canAccessOrg } = await scope();
    membershipTable = { u1: [OTHER] };

    expect(await canAccessOrg(normalToken, HOME)).toBe(false);
    expect(await canAccessOrg(crossToken, HOME)).toBe(false);
  });

  it("checks the database on every call rather than caching the answer", async () => {
    const { canAccessOrg } = await scope();
    await canAccessOrg(crossToken, OTHER);
    await canAccessOrg(crossToken, OTHER);

    expect(membershipFindFirst).toHaveBeenCalledTimes(2);
  });
});

describe("accessibleOrgIds", () => {
  it("gives a normal token only its own org", async () => {
    const { accessibleOrgIds } = await scope();
    expect(await accessibleOrgIds(normalToken)).toEqual([HOME]);
  });

  it("gives a cross-org token the union of its user's memberships", async () => {
    const { accessibleOrgIds } = await scope();
    expect((await accessibleOrgIds(crossToken)).sort()).toEqual(
      [HOME, OTHER].sort()
    );
  });

  it("never includes an org the user is not a member of", async () => {
    const { accessibleOrgIds } = await scope();
    expect(await accessibleOrgIds(crossToken)).not.toContain(FOREIGN);
  });

  it("returns nothing once the user's last membership is revoked", async () => {
    const { accessibleOrgIds } = await scope();
    membershipTable = { u1: [] };

    expect(await accessibleOrgIds(normalToken)).toEqual([]);
    expect(await accessibleOrgIds(crossToken)).toEqual([]);
  });
});

describe("resolveTargetOrg", () => {
  it("defaults to the token's own org", async () => {
    const { resolveTargetOrg } = await scope();
    expect(await resolveTargetOrg(normalToken)).toBe(HOME);
  });

  it("refuses a caller-supplied org a normal token has no claim to", async () => {
    const { resolveTargetOrg } = await scope();
    expect(await resolveTargetOrg(normalToken, OTHER)).toBeNull();
  });

  it("honors a caller-supplied org a cross-org token's user belongs to", async () => {
    const { resolveTargetOrg } = await scope();
    expect(await resolveTargetOrg(crossToken, OTHER)).toBe(OTHER);
  });

  it("refuses a caller-supplied org nobody vouches for", async () => {
    const { resolveTargetOrg } = await scope();
    expect(await resolveTargetOrg(crossToken, FOREIGN)).toBeNull();
  });
});
