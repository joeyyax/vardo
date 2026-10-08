// verifyOrgAccess is the gate every org route goes through. The first block
// fixes requireOrg and checks the role, capability and instance-admin rules;
// the second runs the real session module with a pinned API token.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import type { Capability } from "@/lib/auth/permissions";

const h = vi.hoisted(() => ({
  requireOrg: vi.fn(),
  bearer: { value: null as string | null },
  tokenOrg: { value: "org-a" },
  features: vi.fn(),
}));

vi.mock("react", () => ({ cache: <T>(fn: T) => fn }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.bearer.value ? { authorization: `Bearer ${h.bearer.value}` } : {}),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => ({ user: { id: "u1" }, session: { id: "s1" } }) } },
}));
vi.mock("@/lib/auth/api-token", () => ({
  findApiToken: async () => ({
    id: "t1",
    userId: "u1",
    organizationId: h.tokenOrg.value,
    crossOrg: false,
    expiresAt: null,
  }),
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: h.features }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

// The unit block swaps requireOrg; the integration block keeps the real one.
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    requireOrg: (...args: []) => (h.requireOrg.getMockImplementation() ? h.requireOrg(...args) : actual.requireOrg()),
  };
});

const { verifyOrgAccess } = await import("@/lib/api/verify-access");

const org = (id: string) => ({ id, name: id, isSystemManaged: false });
function asRole(role: string, orgId = "org-a") {
  h.requireOrg.mockResolvedValue({
    organization: org(orgId),
    membership: { id: "m1", role },
    session: { user: { id: "u1" }, authMethod: "session" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireOrg.mockReset();
  dbMock.reset();
  dbMock.query.user.findFirst.mockResolvedValue({ id: "u1", name: "U", email: "u@x", isAppAdmin: false });
  h.features.mockResolvedValue(true);
  h.bearer.value = null;
  h.tokenOrg.value = "org-a";
});

describe("verifyOrgAccess — role and capability", () => {
  // [role, capability, allowed]
  const table: Array<[string, Capability, boolean]> = [
    ["owner", "org.view", true],
    ["admin", "org.view", true],
    ["member", "org.view", true],
    ["viewer", "org.view", true],
    ["owner", "org.delete", true],
    ["admin", "org.delete", false],
    ["member", "org.delete", false],
    ["admin", "org.members.manage", true],
    ["member", "org.members.manage", false],
    ["member", "env.write", true],
    ["viewer", "env.write", false],
    ["admin", "app.delete", true],
    ["member", "app.delete", false],
  ];

  it.each(table)("%s + %s -> %s", async (role, cap, allowed) => {
    asRole(role);
    const result = await verifyOrgAccess("org-a", cap);
    if (allowed) {
      expect(result).toMatchObject({ organization: { id: "org-a" }, membership: { role } });
    } else {
      expect(result).toBeNull();
    }
  });

  it("returns the session alongside the organization and membership", async () => {
    asRole("member");
    expect(await verifyOrgAccess("org-a", "org.view")).toEqual({
      organization: org("org-a"),
      membership: { id: "m1", role: "member" },
      session: { user: { id: "u1" }, authMethod: "session" },
    });
  });

  it("denies a role it does not know", async () => {
    asRole("superuser");
    expect(await verifyOrgAccess("org-a", "org.view")).toBeNull();
  });

  it("denies a member of a different org than the one asked for", async () => {
    asRole("owner", "org-a");
    expect(await verifyOrgAccess("org-b", "org.view")).toBeNull();
  });

  it("lets the error from requireOrg through when there is no session", async () => {
    h.requireOrg.mockRejectedValue(new Error("Unauthorized"));
    await expect(verifyOrgAccess("org-a", "org.view")).rejects.toThrow("Unauthorized");
  });
});

describe("verifyOrgAccess — instance admin", () => {
  it("grants an instance admin the backup capability their org role lacks", async () => {
    asRole("member");
    dbMock.query.user.findFirst.mockResolvedValue({ id: "u1", isAppAdmin: true });
    expect(await verifyOrgAccess("org-a", "backup.delete")).not.toBeNull();
  });

  it("denies the same backup capability to a member who is not an instance admin", async () => {
    asRole("member");
    expect(await verifyOrgAccess("org-a", "backup.delete")).toBeNull();
  });

  it("grants nothing outside the backup capabilities", async () => {
    asRole("member");
    dbMock.query.user.findFirst.mockResolvedValue({ id: "u1", isAppAdmin: true });
    expect(await verifyOrgAccess("org-a", "org.settings")).toBeNull();
  });

  it("does not ask who the instance admin is for a capability that cannot use it", async () => {
    asRole("member");
    await verifyOrgAccess("org-a", "org.view");
    expect(dbMock.query.user.findFirst).not.toHaveBeenCalled();
  });

  it("does not stretch to another org", async () => {
    asRole("member", "org-a");
    dbMock.query.user.findFirst.mockResolvedValue({ id: "u1", isAppAdmin: true });
    expect(await verifyOrgAccess("org-b", "backup.delete")).toBeNull();
  });
});

describe("verifyOrgAccess — API token pinned to an org", () => {
  const membership = (orgId: string, role = "admin") => ({
    id: `m-${orgId}`,
    role,
    organizationId: orgId,
    organization: org(orgId),
  });

  beforeEach(() => {
    h.bearer.value = "tok";
    dbMock.query.user.findFirst.mockResolvedValue({ id: "u1", name: "U", email: "u@x", isAppAdmin: false });
    // The pinned lookup finds org-a; the fallback list would offer org-b too.
    dbMock.query.memberships.findFirst.mockResolvedValue(membership("org-a"));
    dbMock.query.memberships.findMany.mockResolvedValue([membership("org-a"), membership("org-b")]);
  });

  it("admits the org the token was minted for", async () => {
    const access = await verifyOrgAccess("org-a", "org.settings");
    expect(access).toMatchObject({ organization: { id: "org-a" }, session: { authMethod: "token" } });
  });

  it("refuses another org the same user belongs to", async () => {
    expect(await verifyOrgAccess("org-b", "org.view")).toBeNull();
  });

  it("fails closed, with no fallback to another membership, once the user has left the pinned org", async () => {
    dbMock.query.memberships.findFirst.mockResolvedValue(undefined);
    await expect(verifyOrgAccess("org-b", "org.view")).rejects.toThrow("No organization found");
  });

  it("never lends a token instance-admin power, even for an instance admin's token", async () => {
    dbMock.query.user.findFirst.mockResolvedValue({ id: "u1", name: "U", email: "u@x", isAppAdmin: true });
    dbMock.query.memberships.findFirst.mockResolvedValue(membership("org-a", "member"));
    expect(await verifyOrgAccess("org-a", "backup.delete")).toBeNull();
  });
});

describe("verifyOrgAccess — the teams flag", () => {
  it("still admits an existing member when teams is off", async () => {
    h.features.mockImplementation(async (flag: string) => flag !== "teams");
    h.bearer.value = null;
    asRole("member");
    expect(await verifyOrgAccess("org-a", "org.view")).not.toBeNull();
    expect(h.features).not.toHaveBeenCalledWith("teams");
  });
});
